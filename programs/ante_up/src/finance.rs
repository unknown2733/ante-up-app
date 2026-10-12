use anchor_lang::prelude::*;
use ante_up_math::{self as math, Direction, Side};
use crate::{AdmissionState, Config, DataStatus, ErrorCode, Market, MarketPhase};
use crate::token;

const UNIT: u64 = 1_000_000;
const KEYWORD_SUPPLY: u64 = 2_000 * UNIT;
const CURVE_CAP: u64 = 1_000 * UNIT;
const REGISTRATION_FEE: u64 = 10 * UNIT;
const SUPPORT_PER_MARKET: u64 = 10_000 * UNIT;
const SUPPORT_TOTAL: u64 = 50_000 * UNIT;
const BUFFER: u64 = 500 * UNIT;
const INITIAL_FREE: u64 = 3_000 * UNIT;
const WEEK: i64 = 604_800;
const LP_DURATION: i64 = 900;
const PRICE_STALE: i64 = 600;

#[account]
pub struct FinanceConfig {
    pub admin: Pubkey,
    pub payment_mint: Pubkey,
    pub protocol_treasury: Pubkey,
    pub faucet_amount: u64,
    pub faucet_cooldown: i64,
    pub faucet_total_limit: u64,
    pub faucet_minted: u64,
    pub supported_markets: u8,
    pub support_spent: u64,
}

#[account]
pub struct FaucetReceipt { pub wallet: Pubkey, pub last_claim_at: i64, pub total_received: u64 }

#[account]
pub struct FinanceMarket {
    pub market: Pubkey,
    pub keyword_mint: Pubkey,
    pub payment_vault: Pubkey,
    pub curve_inventory: Pubkey,
    pub vault_inventory: Pubkey,
    pub bump: u8,
    pub state_version: u64,
    pub curve_sold: u64,
    pub curve_reserve: u64,
    pub market_fees: u64,
    pub external_q: u64,
    pub anchor_pg: u64,
    pub anchor_sg: u64,
    pub anchor_dg: u64,
    pub pmax: u64,
    pub pro_reserved: u64,
    pub other_reserved: u64,
    pub open_positions: u32,
    pub total_shares: u64,
    pub locked_shares: u64,
    pub lp_window_start: i64,
    pub lp_window_end: i64,
    pub pro_reopen_at: i64,
    pub current_maturity: i64,
    pub current_cycle: u64,
    pub last_lp_maturity: i64,
    pub lp_generation: u64,
}

#[account]
pub struct ProPosition {
    pub market: Pubkey, pub owner: Pubkey, pub id: u64, pub cycle: u64,
    pub direction: PositionDirection, pub collateral: u64, pub notional: u64, pub leverage_bps: u64,
    pub entry_price: u64, pub maximum_payout: u64, pub capital: u64,
    pub prepaid_fee: u64, pub opened_at: i64, pub maturity: i64,
    pub state: PositionState, pub settlement_price: u64,
}

#[account]
pub struct ProClaim {
    pub market: Pubkey, pub owner: Pubkey, pub position: Pubkey,
    pub payout: u64, pub refund: u64, pub paid: bool,
}

#[account]
pub struct LpHolding { pub market: Pubkey, pub owner: Pubkey, pub shares: u64 }

#[account]
pub struct SettlementEpoch {
    pub market: Pubkey, pub epoch: u64, pub cycle: u64, pub maturity_at: i64,
    pub candidate_hash: [u8; 32], pub evidence_hash: [u8; 32],
    pub mode: SettlementMode, pub eligible_at: i64, pub effective_close_at: i64,
    pub accepted_at: i64, pub price: u64, pub activity_now_q12: u64,
    pub activity_7d_q12: u64, pub query_version: u64, pub config_version: u64,
    pub outage_started_at: i64,
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum PositionDirection { Long, Short }
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum PositionState { Open, Settled }
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum SettlementMode { Normal, Recovery, Emergency }

#[derive(Accounts)]
pub struct InitializeFinance<'info> {
    #[account(seeds = [b"config"], bump, has_one = admin)] pub config: Account<'info, Config>,
    #[account(init, payer = admin, space = 8 + 160, seeds = [b"finance-config"], bump)]
    pub finance_config: Account<'info, FinanceConfig>,
    /// CHECK: classic SPL Token mint checked below, including decimals and PDA authority.
    pub payment_mint: UncheckedAccount<'info>,
    /// CHECK: classic SPL Token account checked below, owned by admin.
    pub protocol_treasury: UncheckedAccount<'info>,
    #[account(mut)] pub admin: Signer<'info>,
    /// CHECK: constrained to the classic SPL Token program and checked in CPI helper.
    #[account(address = token::TOKEN_ID)] pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ConfigureFaucet<'info> {
    #[account(mut, seeds = [b"finance-config"], bump, has_one = admin)] pub finance_config: Account<'info, FinanceConfig>,
    pub admin: Signer<'info>,
}

#[derive(Accounts)]
pub struct ClaimFaucet<'info> {
    #[account(mut, seeds = [b"finance-config"], bump)] pub finance_config: Account<'info, FinanceConfig>,
    /// CHECK: key and mint authority checked against finance config.
    #[account(mut, address = finance_config.payment_mint)] pub payment_mint: UncheckedAccount<'info>,
    /// CHECK: classic token account checked against wallet and mint.
    #[account(mut)] pub recipient_payment: UncheckedAccount<'info>,
    #[account(init_if_needed, payer = wallet, space = 8 + 64, seeds = [b"faucet", wallet.key().as_ref()], bump)]
    pub receipt: Account<'info, FaucetReceipt>,
    #[account(mut)] pub wallet: Signer<'info>,
    #[account(address = token::TOKEN_ID)] /// CHECK: classic SPL Token program.
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(market_id: [u8; 32])]
pub struct RegisterFinancialMarket<'info> {
    #[account(seeds = [b"finance-config"], bump)] pub finance_config: Account<'info, FinanceConfig>,
    #[account(init, payer = registrant, space = 8 + 512, seeds = [b"market", market_id.as_ref()], bump)]
    pub market: Account<'info, Market>,
    #[account(init, payer = registrant, space = 8 + 512, seeds = [b"finance", market.key().as_ref()], bump)]
    pub finance_market: Account<'info, FinanceMarket>,
    /// CHECK: initialized as an SPL mint in this instruction.
    #[account(init, payer = registrant, space = token::MINT_LEN, owner = token_program.key(),
        seeds = [b"keyword-mint", market.key().as_ref()], bump)]
    pub keyword_mint: UncheckedAccount<'info>,
    /// CHECK: initialized as an SPL token account in this instruction.
    #[account(init, payer = registrant, space = token::ACCOUNT_LEN, owner = token_program.key(),
        seeds = [b"curve-stock", market.key().as_ref()], bump)]
    pub curve_inventory: UncheckedAccount<'info>,
    /// CHECK: initialized as an SPL token account in this instruction.
    #[account(init, payer = registrant, space = token::ACCOUNT_LEN, owner = token_program.key(),
        seeds = [b"vault-stock", market.key().as_ref()], bump)]
    pub vault_inventory: UncheckedAccount<'info>,
    /// CHECK: initialized as an SPL token account in this instruction.
    #[account(init, payer = registrant, space = token::ACCOUNT_LEN, owner = token_program.key(),
        seeds = [b"payment-vault", market.key().as_ref()], bump)]
    pub payment_vault: UncheckedAccount<'info>,
    /// CHECK: validated as the configured SPL payment mint.
    #[account(address = finance_config.payment_mint)] pub payment_mint: UncheckedAccount<'info>,
    /// CHECK: validated as registrant's SPL payment account.
    #[account(mut)] pub registrant_payment: UncheckedAccount<'info>,
    /// CHECK: validated as configured protocol SPL payment treasury.
    #[account(mut, address = finance_config.protocol_treasury)] pub protocol_treasury: UncheckedAccount<'info>,
    #[account(mut)] pub registrant: Signer<'info>,
    #[account(address = token::TOKEN_ID)] /// CHECK: classic SPL Token program.
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CurveTrade<'info> {
    #[account(seeds = [b"config"], bump)] pub config: Account<'info, Config>,
    #[account(seeds = [b"finance-config"], bump)] pub finance_config: Account<'info, FinanceConfig>,
    #[account(seeds = [b"market", market.id.as_ref()], bump)] pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"finance", market.key().as_ref()], bump = finance_market.bump,
        constraint = finance_market.market == market.key() @ ErrorCode::InvalidInput)]
    pub finance_market: Account<'info, FinanceMarket>,
    /// CHECK: all token identities and owners checked in handler.
    #[account(address = finance_market.keyword_mint)] pub keyword_mint: UncheckedAccount<'info>,
    /// CHECK: all token identities and owners checked in handler.
    #[account(mut, address = finance_market.curve_inventory)] pub curve_inventory: UncheckedAccount<'info>,
    /// CHECK: all token identities and owners checked in handler.
    #[account(mut, address = finance_market.payment_vault)] pub payment_vault: UncheckedAccount<'info>,
    /// CHECK: all token identities and owners checked in handler.
    #[account(address = finance_config.payment_mint)] pub payment_mint: UncheckedAccount<'info>,
    /// CHECK: user SPL token account checked against signer and mint.
    #[account(mut)] pub user_keyword: UncheckedAccount<'info>,
    /// CHECK: user SPL token account checked against signer and mint.
    #[account(mut)] pub user_payment: UncheckedAccount<'info>,
    /// CHECK: configured SPL protocol treasury.
    #[account(mut, address = finance_config.protocol_treasury)] pub protocol_treasury: UncheckedAccount<'info>,
    pub user: Signer<'info>,
    #[account(address = token::TOKEN_ID)] /// CHECK: classic SPL Token program.
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct Graduate<'info> {
    #[account(seeds = [b"config"], bump)] pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"finance-config"], bump, has_one = admin)] pub finance_config: Account<'info, FinanceConfig>,
    #[account(mut, seeds = [b"market", market.id.as_ref()], bump)] pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"finance", market.key().as_ref()], bump = finance_market.bump,
        constraint = finance_market.market == market.key() @ ErrorCode::InvalidInput)]
    pub finance_market: Account<'info, FinanceMarket>,
    #[account(seeds = [b"snapshot", market.key().as_ref(), &snapshot.sequence.to_le_bytes()], bump,
        constraint = snapshot.market == market.key() @ ErrorCode::InvalidInput)]
    pub snapshot: Account<'info, crate::Snapshot>,
    /// CHECK: valid SPL payment mint.
    #[account(address = finance_config.payment_mint)] pub payment_mint: UncheckedAccount<'info>,
    /// CHECK: actual SPL vault balance checked in handler.
    #[account(mut, address = finance_market.payment_vault)] pub payment_vault: UncheckedAccount<'info>,
    /// CHECK: administrator-owned SPL support source checked in handler.
    #[account(mut)] pub support_payment: UncheckedAccount<'info>,
    #[account(mut)] pub admin: Signer<'info>,
    #[account(address = token::TOKEN_ID)] /// CHECK: classic SPL Token program.
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SpotTrade<'info> {
    #[account(seeds = [b"config"], bump)] pub config: Account<'info, Config>,
    #[account(seeds = [b"finance-config"], bump)] pub finance_config: Account<'info, FinanceConfig>,
    #[account(seeds = [b"market", market.id.as_ref()], bump)] pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"finance", market.key().as_ref()], bump = finance_market.bump,
        constraint = finance_market.market == market.key() @ ErrorCode::InvalidInput)]
    pub finance_market: Account<'info, FinanceMarket>,
    /// CHECK: mint supply and revoked authority checked in handler.
    #[account(address = finance_market.keyword_mint)] pub keyword_mint: UncheckedAccount<'info>,
    /// CHECK: vault inventory owner/mint checked in handler.
    #[account(mut, address = finance_market.vault_inventory)] pub vault_inventory: UncheckedAccount<'info>,
    /// CHECK: vault payment owner/mint checked in handler.
    #[account(mut, address = finance_market.payment_vault)] pub payment_vault: UncheckedAccount<'info>,
    /// CHECK: configured six-decimal mint checked in handler.
    #[account(address = finance_config.payment_mint)] pub payment_mint: UncheckedAccount<'info>,
    /// CHECK: signer-owned token account checked in handler.
    #[account(mut)] pub user_keyword: UncheckedAccount<'info>,
    /// CHECK: signer-owned token account checked in handler.
    #[account(mut)] pub user_payment: UncheckedAccount<'info>,
    /// CHECK: configured treasury checked in handler.
    #[account(mut, address = finance_config.protocol_treasury)] pub protocol_treasury: UncheckedAccount<'info>,
    pub user: Signer<'info>,
    #[account(address = token::TOKEN_ID)] /// CHECK: classic SPL Token program.
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(position_id: u64)]
pub struct OpenPro<'info> {
    #[account(seeds = [b"config"], bump)] pub config: Account<'info, Config>,
    #[account(seeds = [b"finance-config"], bump)] pub finance_config: Account<'info, FinanceConfig>,
    #[account(seeds = [b"market", market.id.as_ref()], bump)] pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"finance", market.key().as_ref()], bump = finance_market.bump,
        constraint = finance_market.market == market.key() @ ErrorCode::InvalidInput)]
    pub finance_market: Account<'info, FinanceMarket>,
    #[account(init, payer = owner, space = 8 + 256,
        seeds = [b"position", market.key().as_ref(), owner.key().as_ref(), &position_id.to_le_bytes()], bump)]
    pub position: Account<'info, ProPosition>,
    /// CHECK: classic mint checked in handler.
    #[account(address = finance_config.payment_mint)] pub payment_mint: UncheckedAccount<'info>,
    /// CHECK: classic token account checked in handler.
    #[account(mut, address = finance_market.payment_vault)] pub payment_vault: UncheckedAccount<'info>,
    /// CHECK: signer-owned classic token account checked in handler.
    #[account(mut)] pub owner_payment: UncheckedAccount<'info>,
    /// CHECK: configured treasury checked in handler.
    #[account(mut, address = finance_config.protocol_treasury)] pub protocol_treasury: UncheckedAccount<'info>,
    #[account(mut)] pub owner: Signer<'info>,
    #[account(address = token::TOKEN_ID)] /// CHECK: classic SPL Token program.
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AcceptSettlement<'info> {
    #[account(seeds = [b"config"], bump, has_one = publisher)] pub config: Account<'info, Config>,
    #[account(seeds = [b"market", market.id.as_ref()], bump)] pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"finance", market.key().as_ref()], bump = finance_market.bump)]
    pub finance_market: Account<'info, FinanceMarket>,
    #[account(init, payer = publisher, space = 8 + 256,
        seeds = [b"settlement", market.key().as_ref(), &finance_market.current_cycle.to_le_bytes()], bump)]
    pub settlement: Account<'info, SettlementEpoch>,
    #[account(mut)] pub publisher: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClosePro<'info> {
    #[account(seeds = [b"config"], bump)] pub config: Account<'info, Config>,
    #[account(seeds = [b"finance-config"], bump)] pub finance_config: Account<'info, FinanceConfig>,
    #[account(seeds = [b"market", market.id.as_ref()], bump)] pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"finance", market.key().as_ref()], bump = finance_market.bump)]
    pub finance_market: Account<'info, FinanceMarket>,
    #[account(mut, seeds = [b"position", market.key().as_ref(), owner.key().as_ref(), &position.id.to_le_bytes()], bump)]
    pub position: Account<'info, ProPosition>,
    #[account(init, payer = owner, space = 8 + 128, seeds = [b"claim", position.key().as_ref()], bump)]
    pub claim: Account<'info, ProClaim>,
    /// CHECK: derived PDA is permitted to be absent, but an accepted settlement blocks early exit.
    #[account(seeds = [b"settlement", market.key().as_ref(), &position.cycle.to_le_bytes()], bump)]
    pub settlement: UncheckedAccount<'info>,
    #[account(mut)] pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SettlePro<'info> {
    #[account(seeds = [b"market", market.id.as_ref()], bump)] pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"finance", market.key().as_ref()], bump = finance_market.bump)]
    pub finance_market: Account<'info, FinanceMarket>,
    #[account(mut, seeds = [b"position", market.key().as_ref(), position.owner.as_ref(), &position.id.to_le_bytes()], bump)]
    pub position: Account<'info, ProPosition>,
    #[account(seeds = [b"settlement", market.key().as_ref(), &position.cycle.to_le_bytes()], bump)]
    pub settlement: Account<'info, SettlementEpoch>,
    #[account(init, payer = keeper, space = 8 + 128, seeds = [b"claim", position.key().as_ref()], bump)]
    pub claim: Account<'info, ProClaim>,
    #[account(mut)] pub keeper: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimPro<'info> {
    #[account(seeds = [b"finance-config"], bump)] pub finance_config: Account<'info, FinanceConfig>,
    #[account(seeds = [b"market", market.id.as_ref()], bump)] pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"finance", market.key().as_ref()], bump = finance_market.bump)]
    pub finance_market: Account<'info, FinanceMarket>,
    #[account(seeds = [b"position", market.key().as_ref(), owner.key().as_ref(), &position.id.to_le_bytes()], bump)]
    pub position: Account<'info, ProPosition>,
    #[account(mut, seeds = [b"claim", position.key().as_ref()], bump)]
    pub claim: Account<'info, ProClaim>,
    /// CHECK: configured SPL mint checked in handler.
    #[account(address = finance_config.payment_mint)] pub payment_mint: UncheckedAccount<'info>,
    /// CHECK: vault owner/mint checked in handler.
    #[account(mut, address = finance_market.payment_vault)] pub payment_vault: UncheckedAccount<'info>,
    /// CHECK: claimant owner/mint checked in handler.
    #[account(mut)] pub owner_payment: UncheckedAccount<'info>,
    pub owner: Signer<'info>,
    #[account(address = token::TOKEN_ID)] /// CHECK: classic SPL Token program.
    pub token_program: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct StartLpWindow<'info> {
    #[account(seeds = [b"config"], bump, has_one = publisher)] pub config: Account<'info, Config>,
    #[account(seeds = [b"market", market.id.as_ref()], bump)] pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"finance", market.key().as_ref()], bump = finance_market.bump)]
    pub finance_market: Account<'info, FinanceMarket>,
    /// CHECK: derived accepted settlement may be absent for an empty cycle.
    #[account(seeds = [b"settlement", market.key().as_ref(), &finance_market.current_cycle.to_le_bytes()], bump)]
    pub settlement: UncheckedAccount<'info>,
    pub publisher: Signer<'info>,
}

#[derive(Accounts)]
pub struct LpTrade<'info> {
    #[account(seeds = [b"config"], bump)] pub config: Account<'info, Config>,
    #[account(seeds = [b"finance-config"], bump)] pub finance_config: Account<'info, FinanceConfig>,
    #[account(seeds = [b"market", market.id.as_ref()], bump)] pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"finance", market.key().as_ref()], bump = finance_market.bump)]
    pub finance_market: Account<'info, FinanceMarket>,
    #[account(init_if_needed, payer = owner, space = 8 + 96,
        seeds = [b"lp", market.key().as_ref(), owner.key().as_ref()], bump)]
    pub holding: Account<'info, LpHolding>,
    /// CHECK: configured six-decimal SPL mint checked in handler.
    #[account(address = finance_config.payment_mint)] pub payment_mint: UncheckedAccount<'info>,
    /// CHECK: vault token account owner/mint checked in handler.
    #[account(mut, address = finance_market.payment_vault)] pub payment_vault: UncheckedAccount<'info>,
    /// CHECK: signer token account owner/mint checked in handler.
    #[account(mut)] pub owner_payment: UncheckedAccount<'info>,
    #[account(mut)] pub owner: Signer<'info>,
    #[account(address = token::TOKEN_ID)] /// CHECK: classic SPL Token program.
    pub token_program: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

fn checked_add(a: u64, b: u64) -> Result<u64> { a.checked_add(b).ok_or(error!(ErrorCode::Overflow)) }
fn checked_sub(a: u64, b: u64) -> Result<u64> { a.checked_sub(b).ok_or(error!(ErrorCode::Overflow)) }
fn math_result<T>(result: math::Result<T>) -> Result<T> { result.map_err(|_| error!(ErrorCode::InvalidInput)) }
fn quote(now: i64, deadline: i64, sequence: u64, config_version: u64, state_version: u64,
    market: &Market, config: &Config, finance: &FinanceMarket) -> Result<()> {
    require!(deadline >= now && deadline <= now.saturating_add(30), ErrorCode::QuoteExpired);
    require!(sequence == market.latest_sequence && config_version == config.config_version &&
        state_version == finance.state_version, ErrorCode::VersionMismatch);
    Ok(())
}
fn quote_curve(now: i64, deadline: i64, sequence: u64, config_version: u64, state_version: u64,
    config: &Config, finance: &FinanceMarket) -> Result<()> {
    require!(deadline >= now && deadline <= now.saturating_add(30), ErrorCode::QuoteExpired);
    require!(sequence == 0 && config_version == config.config_version &&
        state_version == finance.state_version, ErrorCode::VersionMismatch);
    Ok(())
}
fn price(market: &Market, finance: &FinanceMarket, now: i64, entry: bool) -> Result<u64> {
    require!(market.phase == MarketPhase::Indexed, ErrorCode::WrongPhase);
    require!(matches!(market.data_status, DataStatus::Valid | DataStatus::LowActivity), ErrorCode::DataUnavailable);
    require!(market.latest_data_through <= now && now.saturating_sub(market.latest_data_through) < PRICE_STALE,
        ErrorCode::DataUnavailable);
    if entry { require!(market.data_status == DataStatus::Valid && market.admission.state == AdmissionState::Open,
        ErrorCode::DataUnavailable); }
    let current = math_result(math::index_price(finance.anchor_pg, finance.anchor_sg, finance.anchor_dg,
        market.latest_now_q12.ok_or(error!(ErrorCode::DataUnavailable))?,
        market.latest_7d_q12.ok_or(error!(ErrorCode::DataUnavailable))?))?.price;
    if entry { require!(current > 0, ErrorCode::InvalidInput); }
    Ok(current)
}
fn lp_price(market: &Market, finance: &FinanceMarket, now: i64) -> Result<u64> {
    require!(market.data_status == DataStatus::LowActivity ||
        (market.data_status == DataStatus::Valid && market.admission.state == AdmissionState::Open),
        ErrorCode::DataUnavailable);
    price(market, finance, now, false)
}
fn solvent(finance: &FinanceMarket, assets: u64) -> Result<()> {
    require!(math_result(math::free_capital(assets, finance.external_q, finance.pmax,
        finance.pro_reserved, finance.other_reserved, BUFFER))? >= 0, ErrorCode::InsufficientCapital);
    Ok(())
}
fn finance_seeds<'a>(market: &'a Pubkey, bump: &'a [u8; 1]) -> [&'a [u8]; 3] {
    [b"finance", market.as_ref(), bump]
}
fn next_monday(now: i64) -> Result<i64> {
    // 1970-01-05 00:00 UTC was a Monday.
    now.checked_sub(345_600).and_then(|v| v.div_euclid(WEEK).checked_add(1))
        .and_then(|v| v.checked_mul(WEEK)).and_then(|v| v.checked_add(345_600))
        .ok_or(error!(ErrorCode::Overflow))
}
fn current_monday(now: i64) -> Result<i64> {
    now.checked_sub(345_600).and_then(|v| v.div_euclid(WEEK).checked_mul(WEEK))
        .and_then(|v| v.checked_add(345_600)).ok_or(error!(ErrorCode::Overflow))
}
fn nav(fm: &FinanceMarket, assets: u64, current_price: u64) -> Result<u64> {
    let spot_debt = math_result(math::spot_gross(fm.external_q, current_price, Side::Sell))?;
    checked_sub(checked_sub(assets, spot_debt)?, fm.other_reserved)
}
fn settle_position(fm: &mut FinanceMarket, position: &mut ProPosition, claim: &mut ProClaim,
    price_atoms: u64, effective_close_at: i64, position_key: Pubkey) -> Result<()> {
    require!(position.state == PositionState::Open && position.market == fm.market &&
        effective_close_at >= position.opened_at && effective_close_at <= position.maturity,
        ErrorCode::AlreadyExecuted);
    let direction = if position.direction == PositionDirection::Long {Direction::Long} else {Direction::Short};
    let result = math_result(math::pro(position.collateral, position.leverage_bps,
        position.entry_price, price_atoms, fm.pmax, direction))?;
    // Entry leverage is fixed by the stored notional. Recomputed M must match the reservation.
    require!(result.notional == position.notional && result.reserve == position.maximum_payout,
        ErrorCode::InvalidInput);
    let duration = u64::try_from(position.maturity - position.opened_at).map_err(|_| error!(ErrorCode::Overflow))?;
    let elapsed = u64::try_from(effective_close_at - position.opened_at).map_err(|_| error!(ErrorCode::Overflow))?;
    let fees = math_result(math::time_fee(position.capital, position.notional, duration, elapsed))?;
    require!(fees.prepaid == position.prepaid_fee, ErrorCode::InvalidInput);
    let due = checked_add(result.payout, fees.refund)?;
    fm.pro_reserved = checked_sub(fm.pro_reserved, position.maximum_payout)?;
    fm.other_reserved = checked_add(checked_sub(fm.other_reserved, position.prepaid_fee)?, due)?;
    fm.open_positions = fm.open_positions.checked_sub(1).ok_or(error!(ErrorCode::Overflow))?;
    fm.state_version = checked_add(fm.state_version, 1)?;
    position.state = PositionState::Settled; position.settlement_price = price_atoms;
    claim.market = fm.market; claim.owner = position.owner; claim.position = position_key;
    claim.payout = result.payout; claim.refund = fees.refund; claim.paid = false;
    Ok(())
}

pub fn initialize_finance(ctx: Context<InitializeFinance>, faucet_amount: u64,
    faucet_cooldown: i64, faucet_total_limit: u64) -> Result<()> {
    require!(faucet_amount > 0 && faucet_cooldown >= 86_400 && faucet_total_limit >= faucet_amount,
        ErrorCode::InvalidInput);
    token::require_program(&ctx.accounts.token_program.to_account_info())?;
    token::require_mint(&ctx.accounts.payment_mint.to_account_info(), Some(ctx.accounts.finance_config.key()))?;
    token::amount(&ctx.accounts.protocol_treasury.to_account_info(), ctx.accounts.payment_mint.key(), ctx.accounts.admin.key())?;
    let f = &mut ctx.accounts.finance_config;
    f.admin = ctx.accounts.admin.key();
    f.payment_mint = ctx.accounts.payment_mint.key();
    f.protocol_treasury = ctx.accounts.protocol_treasury.key();
    f.faucet_amount = faucet_amount;
    f.faucet_cooldown = faucet_cooldown;
    f.faucet_total_limit = faucet_total_limit;
    Ok(())
}

pub fn configure_faucet(ctx: Context<ConfigureFaucet>, amount: u64, cooldown: i64, total_limit: u64) -> Result<()> {
    require!(amount > 0 && cooldown >= 86_400 && total_limit >= ctx.accounts.finance_config.faucet_minted,
        ErrorCode::InvalidInput);
    let f = &mut ctx.accounts.finance_config;
    f.faucet_amount = amount; f.faucet_cooldown = cooldown; f.faucet_total_limit = total_limit;
    Ok(())
}

pub fn claim_faucet(ctx: Context<ClaimFaucet>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let f = &mut ctx.accounts.finance_config;
    token::require_mint(&ctx.accounts.payment_mint.to_account_info(), Some(f.key()))?;
    token::amount(&ctx.accounts.recipient_payment.to_account_info(), f.payment_mint, ctx.accounts.wallet.key())?;
    let r = &mut ctx.accounts.receipt;
    require!(r.wallet == Pubkey::default() || r.wallet == ctx.accounts.wallet.key(), ErrorCode::Unauthorized);
    require!(r.last_claim_at == 0 || now.saturating_sub(r.last_claim_at) >= f.faucet_cooldown,
        ErrorCode::LimitReached);
    let new_total = checked_add(f.faucet_minted, f.faucet_amount)?;
    require!(new_total <= f.faucet_total_limit, ErrorCode::LimitReached);
    let bump = [ctx.bumps.finance_config];
    let seeds: &[&[u8]] = &[b"finance-config", &bump];
    token::mint_to_checked(&ctx.accounts.token_program.to_account_info(), &ctx.accounts.payment_mint.to_account_info(),
        &ctx.accounts.recipient_payment.to_account_info(), &f.to_account_info(), f.faucet_amount, &[seeds])?;
    f.faucet_minted = new_total;
    r.wallet = ctx.accounts.wallet.key(); r.last_claim_at = now;
    r.total_received = checked_add(r.total_received, f.faucet_amount)?;
    Ok(())
}

pub fn register_financial_market(ctx: Context<RegisterFinancialMarket>, market_id: [u8; 32],
    query_hash: [u8; 32], query_version: u64) -> Result<()> {
    require!(market_id != [0; 32] && query_hash != [0; 32] && query_version > 0, ErrorCode::InvalidInput);
    let market_key = ctx.accounts.market.key();
    let fkey = ctx.accounts.finance_market.key();
    token::require_mint(&ctx.accounts.payment_mint.to_account_info(), Some(ctx.accounts.finance_config.key()))?;
    token::amount(&ctx.accounts.registrant_payment.to_account_info(), ctx.accounts.payment_mint.key(), ctx.accounts.registrant.key())?;
    token::amount(&ctx.accounts.protocol_treasury.to_account_info(), ctx.accounts.payment_mint.key(), ctx.accounts.finance_config.admin)?;
    token::initialize_mint2(&ctx.accounts.token_program.to_account_info(), &ctx.accounts.keyword_mint.to_account_info(), fkey)?;
    for account in [&ctx.accounts.curve_inventory, &ctx.accounts.vault_inventory] {
        token::initialize_account3(&ctx.accounts.token_program.to_account_info(), &account.to_account_info(),
            &ctx.accounts.keyword_mint.to_account_info(), fkey)?;
    }
    token::initialize_account3(&ctx.accounts.token_program.to_account_info(), &ctx.accounts.payment_vault.to_account_info(),
        &ctx.accounts.payment_mint.to_account_info(), fkey)?;
    token::transfer_checked(&ctx.accounts.token_program.to_account_info(), &ctx.accounts.registrant_payment.to_account_info(),
        &ctx.accounts.payment_mint.to_account_info(), &ctx.accounts.protocol_treasury.to_account_info(),
        &ctx.accounts.registrant.to_account_info(), REGISTRATION_FEE, &[])?;
    let bump = [ctx.bumps.finance_market];
    let seeds = finance_seeds(&market_key, &bump);
    token::mint_to_checked(&ctx.accounts.token_program.to_account_info(), &ctx.accounts.keyword_mint.to_account_info(),
        &ctx.accounts.curve_inventory.to_account_info(), &ctx.accounts.finance_market.to_account_info(), CURVE_CAP, &[&seeds])?;
    token::mint_to_checked(&ctx.accounts.token_program.to_account_info(), &ctx.accounts.keyword_mint.to_account_info(),
        &ctx.accounts.vault_inventory.to_account_info(), &ctx.accounts.finance_market.to_account_info(), CURVE_CAP, &[&seeds])?;
    require!(token::require_mint(&ctx.accounts.keyword_mint.to_account_info(), Some(fkey))? == KEYWORD_SUPPLY,
        ErrorCode::InvalidTokenAccount);
    token::revoke_mint(&ctx.accounts.token_program.to_account_info(), &ctx.accounts.keyword_mint.to_account_info(),
        &ctx.accounts.finance_market.to_account_info(), &[&seeds])?;
    let m = &mut ctx.accounts.market;
    m.id = market_id; m.admin = ctx.accounts.finance_config.admin;
    m.query_hash = query_hash; m.query_version = query_version;
    m.phase = MarketPhase::Curve; m.data_status = DataStatus::Preparing;
    m.admission = crate::TradingAdmission {state: AdmissionState::Blocked, recovery_count: 0,
        reason: Some(crate::AdmissionReason::DataNotReady)};
    m.latest_sequence = 0;
    m.validity_generation = 0;
    let fm = &mut ctx.accounts.finance_market;
    fm.market = market_key; fm.keyword_mint = ctx.accounts.keyword_mint.key();
    fm.payment_vault = ctx.accounts.payment_vault.key();
    fm.curve_inventory = ctx.accounts.curve_inventory.key();
    fm.vault_inventory = ctx.accounts.vault_inventory.key();
    fm.bump = ctx.bumps.finance_market;
    fm.state_version = 1;
    Ok(())
}

pub fn curve_buy(ctx: Context<CurveTrade>, quantity: u64, max_payment: u64,
    expected_sequence: u64, expected_config_version: u64, expected_state_version: u64,
    deadline: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    quote_curve(now, deadline, expected_sequence, expected_config_version, expected_state_version,
        &ctx.accounts.config, &ctx.accounts.finance_market)?;
    require!(ctx.accounts.market.phase == MarketPhase::Curve && quantity > 0, ErrorCode::WrongPhase);
    let fm = &mut ctx.accounts.finance_market;
    let new_q = checked_add(fm.curve_sold, quantity)?;
    require!(new_q <= CURVE_CAP, ErrorCode::LimitReached);
    token::require_mint(&ctx.accounts.keyword_mint.to_account_info(), None)?;
    token::require_mint(&ctx.accounts.payment_mint.to_account_info(), Some(ctx.accounts.finance_config.key()))?;
    token::amount(&ctx.accounts.curve_inventory.to_account_info(), fm.keyword_mint, fm.key())?;
    token::amount(&ctx.accounts.payment_vault.to_account_info(), ctx.accounts.payment_mint.key(), fm.key())?;
    token::amount(&ctx.accounts.user_keyword.to_account_info(), fm.keyword_mint, ctx.accounts.user.key())?;
    token::amount(&ctx.accounts.user_payment.to_account_info(), ctx.accounts.payment_mint.key(), ctx.accounts.user.key())?;
    token::amount(&ctx.accounts.protocol_treasury.to_account_info(), ctx.accounts.payment_mint.key(), ctx.accounts.finance_config.admin)?;
    let gross = math_result(math::curve_gross(fm.curve_sold, new_q, Side::Buy))?;
    let fee = math_result(math::trade_fee(gross))?;
    let total = checked_add(gross, fee.total)?;
    require!(total <= max_payment, ErrorCode::Slippage);
    token::transfer_checked(&ctx.accounts.token_program.to_account_info(), &ctx.accounts.user_payment.to_account_info(),
        &ctx.accounts.payment_mint.to_account_info(), &ctx.accounts.payment_vault.to_account_info(),
        &ctx.accounts.user.to_account_info(), total, &[])?;
    let market_key = ctx.accounts.market.key(); let bump = [fm.bump]; let seeds = finance_seeds(&market_key, &bump);
    if fee.protocol > 0 { token::transfer_checked(&ctx.accounts.token_program.to_account_info(), &ctx.accounts.payment_vault.to_account_info(),
        &ctx.accounts.payment_mint.to_account_info(), &ctx.accounts.protocol_treasury.to_account_info(),
        &fm.to_account_info(), fee.protocol, &[&seeds])?; }
    token::transfer_checked(&ctx.accounts.token_program.to_account_info(), &ctx.accounts.curve_inventory.to_account_info(),
        &ctx.accounts.keyword_mint.to_account_info(), &ctx.accounts.user_keyword.to_account_info(),
        &fm.to_account_info(), quantity, &[&seeds])?;
    fm.curve_sold = new_q;
    fm.curve_reserve = checked_add(fm.curve_reserve, gross)?;
    fm.market_fees = checked_add(fm.market_fees, fee.vault)?;
    fm.state_version = checked_add(fm.state_version, 1)?;
    emit!(FinancialTrade {market: market_key, user: ctx.accounts.user.key(), action: 0,
        quantity, gross, fee: fee.total, price: 0});
    Ok(())
}

pub fn curve_sell(ctx: Context<CurveTrade>, quantity: u64, min_receipt: u64,
    expected_sequence: u64, expected_config_version: u64, expected_state_version: u64,
    deadline: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    quote_curve(now, deadline, expected_sequence, expected_config_version, expected_state_version,
        &ctx.accounts.config, &ctx.accounts.finance_market)?;
    require!(ctx.accounts.market.phase == MarketPhase::Curve && quantity > 0, ErrorCode::WrongPhase);
    let fm = &mut ctx.accounts.finance_market;
    let new_q = checked_sub(fm.curve_sold, quantity)?;
    token::require_mint(&ctx.accounts.keyword_mint.to_account_info(), None)?;
    token::require_mint(&ctx.accounts.payment_mint.to_account_info(), Some(ctx.accounts.finance_config.key()))?;
    token::amount(&ctx.accounts.curve_inventory.to_account_info(), fm.keyword_mint, fm.key())?;
    token::amount(&ctx.accounts.payment_vault.to_account_info(), ctx.accounts.payment_mint.key(), fm.key())?;
    token::amount(&ctx.accounts.user_keyword.to_account_info(), fm.keyword_mint, ctx.accounts.user.key())?;
    token::amount(&ctx.accounts.user_payment.to_account_info(), ctx.accounts.payment_mint.key(), ctx.accounts.user.key())?;
    token::amount(&ctx.accounts.protocol_treasury.to_account_info(), ctx.accounts.payment_mint.key(), ctx.accounts.finance_config.admin)?;
    let gross = math_result(math::curve_gross(fm.curve_sold, new_q, Side::Sell))?;
    let fee = math_result(math::trade_fee(gross))?;
    let receipt = checked_sub(gross, fee.total)?;
    require!(receipt >= min_receipt, ErrorCode::Slippage);
    token::transfer_checked(&ctx.accounts.token_program.to_account_info(), &ctx.accounts.user_keyword.to_account_info(),
        &ctx.accounts.keyword_mint.to_account_info(), &ctx.accounts.curve_inventory.to_account_info(),
        &ctx.accounts.user.to_account_info(), quantity, &[])?;
    let market_key = ctx.accounts.market.key(); let bump = [fm.bump]; let seeds = finance_seeds(&market_key, &bump);
    if receipt > 0 { token::transfer_checked(&ctx.accounts.token_program.to_account_info(), &ctx.accounts.payment_vault.to_account_info(),
        &ctx.accounts.payment_mint.to_account_info(), &ctx.accounts.user_payment.to_account_info(),
        &fm.to_account_info(), receipt, &[&seeds])?; }
    if fee.protocol > 0 { token::transfer_checked(&ctx.accounts.token_program.to_account_info(), &ctx.accounts.payment_vault.to_account_info(),
        &ctx.accounts.payment_mint.to_account_info(), &ctx.accounts.protocol_treasury.to_account_info(),
        &fm.to_account_info(), fee.protocol, &[&seeds])?; }
    fm.curve_sold = new_q;
    fm.curve_reserve = checked_sub(fm.curve_reserve, gross)?;
    fm.market_fees = checked_add(fm.market_fees, fee.vault)?;
    fm.state_version = checked_add(fm.state_version, 1)?;
    emit!(FinancialTrade {market: market_key, user: ctx.accounts.user.key(), action: 1,
        quantity, gross, fee: fee.total, price: 0});
    Ok(())
}

pub fn graduate(ctx: Context<Graduate>, expected_sequence: u64, expected_config_version: u64,
    expected_state_version: u64, deadline: i64, max_contribution: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    quote(now, deadline, expected_sequence, expected_config_version, expected_state_version,
        &ctx.accounts.market, &ctx.accounts.config, &ctx.accounts.finance_market)?;
    let m = &mut ctx.accounts.market;
    let fm = &mut ctx.accounts.finance_market;
    let f = &mut ctx.accounts.finance_config;
    require!(m.phase == MarketPhase::Curve && fm.curve_sold == CURVE_CAP &&
        fm.curve_reserve >= 1_100 * UNIT, ErrorCode::WrongPhase);
    require!(f.supported_markets < 5, ErrorCode::LimitReached);
    require!(m.data_status == DataStatus::Valid && m.admission.state == AdmissionState::Open &&
        m.latest_sequence == ctx.accounts.snapshot.sequence &&
        m.latest_hash == ctx.accounts.snapshot.payload_hash, ErrorCode::DataUnavailable);
    let s = m.latest_now_q12.ok_or(error!(ErrorCode::DataUnavailable))?;
    let d = m.latest_7d_q12.ok_or(error!(ErrorCode::DataUnavailable))?;
    require!(s >= 100 * 1_000_000_000_000 && d >= 100 * 1_000_000_000_000 &&
        s > 0 && u128::from(s) < u128::from(d) * 5 &&
        m.latest_data_through <= now && now.saturating_sub(m.latest_data_through) < PRICE_STALE,
        ErrorCode::DataUnavailable);
    token::require_mint(&ctx.accounts.payment_mint.to_account_info(), Some(f.key()))?;
    let balance = token::amount(&ctx.accounts.payment_vault.to_account_info(), f.payment_mint, fm.key())?;
    require!(balance >= checked_add(fm.curve_reserve, fm.market_fees)?, ErrorCode::InsufficientCapital);
    token::amount(&ctx.accounts.support_payment.to_account_info(), f.payment_mint, ctx.accounts.admin.key())?;
    let pg = 1_200_000u64;
    let pmax = math_result(math::index_price(pg, s, d, s, d))?.maximum;
    let reserve = math_result(math::spot_reserve(CURVE_CAP, pmax))?;
    let target = checked_add(checked_add(reserve, BUFFER)?, INITIAL_FREE)?;
    let contribution = target.saturating_sub(balance);
    require!(contribution <= SUPPORT_PER_MARKET && contribution <= max_contribution &&
        checked_add(f.support_spent, contribution)? <= SUPPORT_TOTAL, ErrorCode::InsufficientCapital);
    if contribution > 0 { token::transfer_checked(&ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.support_payment.to_account_info(), &ctx.accounts.payment_mint.to_account_info(),
        &ctx.accounts.payment_vault.to_account_info(), &ctx.accounts.admin.to_account_info(), contribution, &[])?; }
    let new_assets = checked_add(balance, contribution)?;
    let spot_liability = math_result(math::spot_gross(CURVE_CAP, pg, Side::Sell))?;
    let equity = checked_sub(new_assets, spot_liability)?;
    require!(equity > 0, ErrorCode::InsufficientCapital);
    fm.external_q = CURVE_CAP;
    fm.anchor_pg = pg; fm.anchor_sg = s; fm.anchor_dg = d; fm.pmax = pmax;
    fm.total_shares = equity; fm.locked_shares = equity;
    fm.lp_window_start = now; fm.lp_window_end = now.saturating_add(LP_DURATION);
    fm.pro_reopen_at = fm.lp_window_end;
    fm.lp_generation = m.validity_generation;
    fm.last_lp_maturity = current_monday(now)?;
    fm.state_version = checked_add(fm.state_version, 1)?;
    solvent(fm, new_assets)?;
    m.phase = MarketPhase::Indexed;
    f.support_spent = checked_add(f.support_spent, contribution)?;
    f.supported_markets = f.supported_markets.checked_add(1).ok_or(error!(ErrorCode::Overflow))?;
    emit!(Graduated {market: m.key(), contribution, assets: new_assets, pmax, locked_shares: equity});
    Ok(())
}

pub fn spot_buy(ctx: Context<SpotTrade>, quantity: u64, max_payment: u64,
    expected_sequence: u64, expected_config_version: u64, expected_state_version: u64,
    deadline: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    quote(now, deadline, expected_sequence, expected_config_version, expected_state_version,
        &ctx.accounts.market, &ctx.accounts.config, &ctx.accounts.finance_market)?;
    require!(quantity > 0, ErrorCode::InvalidInput);
    let fm = &mut ctx.accounts.finance_market;
    let current_price = price(&ctx.accounts.market, fm, now, true)?;
    require!(token::require_mint(&ctx.accounts.keyword_mint.to_account_info(), None)? <= KEYWORD_SUPPLY,
        ErrorCode::InvalidTokenAccount);
    token::require_mint(&ctx.accounts.payment_mint.to_account_info(), Some(ctx.accounts.finance_config.key()))?;
    let stock = token::amount(&ctx.accounts.vault_inventory.to_account_info(), fm.keyword_mint, fm.key())?;
    require!(stock >= quantity, ErrorCode::LimitReached);
    let balance = token::amount(&ctx.accounts.payment_vault.to_account_info(), ctx.accounts.payment_mint.key(), fm.key())?;
    token::amount(&ctx.accounts.user_keyword.to_account_info(), fm.keyword_mint, ctx.accounts.user.key())?;
    token::amount(&ctx.accounts.user_payment.to_account_info(), ctx.accounts.payment_mint.key(), ctx.accounts.user.key())?;
    token::amount(&ctx.accounts.protocol_treasury.to_account_info(), ctx.accounts.payment_mint.key(), ctx.accounts.finance_config.admin)?;
    let gross = math_result(math::spot_gross(quantity, current_price, Side::Buy))?;
    let fee = math_result(math::trade_fee(gross))?;
    let total = checked_add(gross, fee.total)?;
    require!(total <= max_payment, ErrorCode::Slippage);
    fm.external_q = checked_add(fm.external_q, quantity)?;
    solvent(fm, checked_add(balance, checked_add(gross, fee.vault)?)?)?;
    token::transfer_checked(&ctx.accounts.token_program.to_account_info(), &ctx.accounts.user_payment.to_account_info(),
        &ctx.accounts.payment_mint.to_account_info(), &ctx.accounts.payment_vault.to_account_info(),
        &ctx.accounts.user.to_account_info(), total, &[])?;
    let market_key = ctx.accounts.market.key(); let bump = [fm.bump]; let seeds = finance_seeds(&market_key, &bump);
    if fee.protocol > 0 { token::transfer_checked(&ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.payment_vault.to_account_info(), &ctx.accounts.payment_mint.to_account_info(),
        &ctx.accounts.protocol_treasury.to_account_info(), &fm.to_account_info(), fee.protocol, &[&seeds])?; }
    token::transfer_checked(&ctx.accounts.token_program.to_account_info(), &ctx.accounts.vault_inventory.to_account_info(),
        &ctx.accounts.keyword_mint.to_account_info(), &ctx.accounts.user_keyword.to_account_info(),
        &fm.to_account_info(), quantity, &[&seeds])?;
    fm.state_version = checked_add(fm.state_version, 1)?;
    emit!(FinancialTrade {market: market_key, user: ctx.accounts.user.key(), action: 2,
        quantity, gross, fee: fee.total, price: current_price});
    Ok(())
}

pub fn spot_sell(ctx: Context<SpotTrade>, quantity: u64, min_receipt: u64,
    expected_sequence: u64, expected_config_version: u64, expected_state_version: u64,
    deadline: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    quote(now, deadline, expected_sequence, expected_config_version, expected_state_version,
        &ctx.accounts.market, &ctx.accounts.config, &ctx.accounts.finance_market)?;
    require!(quantity > 0, ErrorCode::InvalidInput);
    let fm = &mut ctx.accounts.finance_market;
    let current_price = price(&ctx.accounts.market, fm, now, false)?;
    require!(token::require_mint(&ctx.accounts.keyword_mint.to_account_info(), None)? <= KEYWORD_SUPPLY,
        ErrorCode::InvalidTokenAccount);
    token::require_mint(&ctx.accounts.payment_mint.to_account_info(), Some(ctx.accounts.finance_config.key()))?;
    token::amount(&ctx.accounts.vault_inventory.to_account_info(), fm.keyword_mint, fm.key())?;
    let balance = token::amount(&ctx.accounts.payment_vault.to_account_info(), ctx.accounts.payment_mint.key(), fm.key())?;
    token::amount(&ctx.accounts.user_keyword.to_account_info(), fm.keyword_mint, ctx.accounts.user.key())?;
    token::amount(&ctx.accounts.user_payment.to_account_info(), ctx.accounts.payment_mint.key(), ctx.accounts.user.key())?;
    token::amount(&ctx.accounts.protocol_treasury.to_account_info(), ctx.accounts.payment_mint.key(), ctx.accounts.finance_config.admin)?;
    let gross = math_result(math::spot_gross(quantity, current_price, Side::Sell))?;
    let fee = math_result(math::trade_fee(gross))?;
    let receipt = checked_sub(gross, fee.total)?;
    require!(receipt >= min_receipt && balance >= checked_add(receipt, fee.protocol)?, ErrorCode::Slippage);
    fm.external_q = checked_sub(fm.external_q, quantity)?;
    token::transfer_checked(&ctx.accounts.token_program.to_account_info(), &ctx.accounts.user_keyword.to_account_info(),
        &ctx.accounts.keyword_mint.to_account_info(), &ctx.accounts.vault_inventory.to_account_info(),
        &ctx.accounts.user.to_account_info(), quantity, &[])?;
    let market_key = ctx.accounts.market.key(); let bump = [fm.bump]; let seeds = finance_seeds(&market_key, &bump);
    if receipt > 0 { token::transfer_checked(&ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.payment_vault.to_account_info(), &ctx.accounts.payment_mint.to_account_info(),
        &ctx.accounts.user_payment.to_account_info(), &fm.to_account_info(), receipt, &[&seeds])?; }
    if fee.protocol > 0 { token::transfer_checked(&ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.payment_vault.to_account_info(), &ctx.accounts.payment_mint.to_account_info(),
        &ctx.accounts.protocol_treasury.to_account_info(), &fm.to_account_info(), fee.protocol, &[&seeds])?; }
    fm.state_version = checked_add(fm.state_version, 1)?;
    emit!(FinancialTrade {market: market_key, user: ctx.accounts.user.key(), action: 3,
        quantity, gross, fee: fee.total, price: current_price});
    Ok(())
}

pub fn open_pro(ctx: Context<OpenPro>, position_id: u64, collateral: u64, leverage_bps: u64,
    direction: PositionDirection, max_payment: u64, expected_sequence: u64,
    expected_config_version: u64, expected_state_version: u64, deadline: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    quote(now, deadline, expected_sequence, expected_config_version, expected_state_version,
        &ctx.accounts.market, &ctx.accounts.config, &ctx.accounts.finance_market)?;
    let fm = &mut ctx.accounts.finance_market;
    require!(now >= fm.pro_reopen_at && now >= fm.lp_window_end && collateral > 0 &&
        (fm.current_maturity != 0 || fm.lp_generation == ctx.accounts.market.validity_generation),
        ErrorCode::WrongPhase);
    let maturity = next_monday(now)?;
    require!(now < maturity - 1_800 &&
        (fm.current_maturity == 0 || fm.current_maturity == maturity) &&
        current_monday(now)? <= fm.last_lp_maturity, ErrorCode::WrongPhase);
    let p0 = price(&ctx.accounts.market, fm, now, true)?;
    token::require_mint(&ctx.accounts.payment_mint.to_account_info(), Some(ctx.accounts.finance_config.key()))?;
    let balance = token::amount(&ctx.accounts.payment_vault.to_account_info(), ctx.accounts.payment_mint.key(), fm.key())?;
    token::amount(&ctx.accounts.owner_payment.to_account_info(), ctx.accounts.payment_mint.key(), ctx.accounts.owner.key())?;
    token::amount(&ctx.accounts.protocol_treasury.to_account_info(), ctx.accounts.payment_mint.key(), ctx.accounts.finance_config.admin)?;
    let side = if direction == PositionDirection::Long {Direction::Long} else {Direction::Short};
    let terms = math_result(math::pro(collateral, leverage_bps, p0, p0, fm.pmax, side))?;
    let trade_fee = math_result(math::trade_fee(terms.notional))?;
    let duration = u64::try_from(maturity - now).map_err(|_| error!(ErrorCode::Overflow))?;
    let prepaid = math_result(math::time_fee(terms.capital, terms.notional, duration, 0))?.prepaid;
    let payment = checked_add(checked_add(collateral, trade_fee.total)?, prepaid)?;
    require!(payment <= max_payment, ErrorCode::Slippage);
    fm.pro_reserved = checked_add(fm.pro_reserved, terms.reserve)?;
    fm.other_reserved = checked_add(fm.other_reserved, prepaid)?;
    fm.open_positions = fm.open_positions.checked_add(1).ok_or(error!(ErrorCode::Overflow))?;
    solvent(fm, checked_add(balance, checked_add(checked_add(collateral, trade_fee.vault)?, prepaid)?)?)?;
    token::transfer_checked(&ctx.accounts.token_program.to_account_info(), &ctx.accounts.owner_payment.to_account_info(),
        &ctx.accounts.payment_mint.to_account_info(), &ctx.accounts.payment_vault.to_account_info(),
        &ctx.accounts.owner.to_account_info(), payment, &[])?;
    let market_key = ctx.accounts.market.key(); let bump = [fm.bump]; let seeds = finance_seeds(&market_key, &bump);
    if trade_fee.protocol > 0 { token::transfer_checked(&ctx.accounts.token_program.to_account_info(),
        &ctx.accounts.payment_vault.to_account_info(), &ctx.accounts.payment_mint.to_account_info(),
        &ctx.accounts.protocol_treasury.to_account_info(), &fm.to_account_info(), trade_fee.protocol, &[&seeds])?; }
    if fm.current_maturity == 0 { fm.current_cycle = checked_add(fm.current_cycle, 1)?; }
    fm.current_maturity = maturity;
    fm.state_version = checked_add(fm.state_version, 1)?;
    let p = &mut ctx.accounts.position;
    p.market = market_key; p.owner = ctx.accounts.owner.key(); p.id = position_id; p.cycle = fm.current_cycle;
    p.direction = direction; p.collateral = collateral; p.notional = terms.notional; p.leverage_bps = leverage_bps;
    p.entry_price = p0; p.maximum_payout = terms.reserve; p.capital = terms.capital;
    p.prepaid_fee = prepaid; p.opened_at = now; p.maturity = maturity;
    p.state = PositionState::Open;
    emit!(ProOpened {position: p.key(), owner: p.owner, market: p.market,
        collateral, notional: p.notional, maximum_payout: p.maximum_payout, maturity});
    Ok(())
}

pub fn accept_settlement(ctx: Context<AcceptSettlement>, epoch: u64, maturity_at: i64,
    candidate_hash: [u8; 32], evidence_hash: [u8; 32], mode: SettlementMode,
    eligible_at: i64, effective_close_at: i64, outage_started_at: i64,
    settlement_price: u64, activity_now_q12: u64, activity_7d_q12: u64,
    query_version: u64, expected_config_version: u64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let fm = &mut ctx.accounts.finance_market;
    require!(ctx.accounts.market.phase == MarketPhase::Indexed &&
        fm.market == ctx.accounts.market.key() && fm.current_maturity == maturity_at &&
        epoch == fm.current_cycle &&
        maturity_at > 0 && (maturity_at - 345_600).rem_euclid(WEEK) == 0 &&
        candidate_hash != [0; 32] && evidence_hash != [0; 32] &&
        query_version == ctx.accounts.market.query_version &&
        expected_config_version == ctx.accounts.config.config_version &&
        now >= eligible_at && effective_close_at <= maturity_at,
        ErrorCode::InvalidInput);
    let cutoff = maturity_at.checked_add(900).ok_or(error!(ErrorCode::Overflow))?;
    match mode {
        SettlementMode::Normal => require!(eligible_at >= cutoff && effective_close_at == maturity_at &&
            outage_started_at == 0, ErrorCode::InvalidInput),
        SettlementMode::Recovery => require!(eligible_at >= cutoff &&
            eligible_at <= outage_started_at.saturating_add(86_400) &&
            effective_close_at == maturity_at && outage_started_at > 0, ErrorCode::InvalidInput),
        SettlementMode::Emergency => {
            require!(outage_started_at > 0 && eligible_at == outage_started_at.saturating_add(86_400) &&
                effective_close_at == maturity_at.min(eligible_at), ErrorCode::InvalidInput);
        }
    }
    let calculated = math_result(math::index_price(fm.anchor_pg, fm.anchor_sg, fm.anchor_dg,
        activity_now_q12, activity_7d_q12))?;
    require!(calculated.price == settlement_price && calculated.maximum == fm.pmax,
        ErrorCode::InvalidInput);
    let settlement = &mut ctx.accounts.settlement;
    settlement.market = fm.market; settlement.epoch = epoch; settlement.cycle = fm.current_cycle;
    settlement.maturity_at = maturity_at;
    settlement.candidate_hash = candidate_hash; settlement.evidence_hash = evidence_hash;
    settlement.mode = mode; settlement.eligible_at = eligible_at;
    settlement.effective_close_at = effective_close_at; settlement.accepted_at = now;
    settlement.price = settlement_price; settlement.activity_now_q12 = activity_now_q12;
    settlement.activity_7d_q12 = activity_7d_q12; settlement.query_version = query_version;
    settlement.config_version = expected_config_version;
    settlement.outage_started_at = outage_started_at;
    fm.state_version = checked_add(fm.state_version, 1)?;
    emit!(SettlementAccepted {market: fm.market, maturity_at, candidate_hash, price: settlement_price,
        effective_close_at, mode});
    Ok(())
}

pub fn close_pro(ctx: Context<ClosePro>, min_receipt: u64, expected_sequence: u64,
    expected_config_version: u64, expected_state_version: u64, deadline: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    quote(now, deadline, expected_sequence, expected_config_version, expected_state_version,
        &ctx.accounts.market, &ctx.accounts.config, &ctx.accounts.finance_market)?;
    require!(ctx.accounts.position.owner == ctx.accounts.owner.key() &&
        ctx.accounts.position.market == ctx.accounts.market.key() &&
        ctx.accounts.position.state == PositionState::Open &&
        now < ctx.accounts.position.maturity && ctx.accounts.settlement.owner != &crate::ID,
        ErrorCode::Unauthorized);
    let current_price = price(&ctx.accounts.market, &ctx.accounts.finance_market, now, false)?;
    let position_key = ctx.accounts.position.key();
    settle_position(&mut ctx.accounts.finance_market, &mut ctx.accounts.position,
        &mut ctx.accounts.claim, current_price, now, position_key)?;
    require!(checked_add(ctx.accounts.claim.payout, ctx.accounts.claim.refund)? >= min_receipt,
        ErrorCode::Slippage);
    emit!(ProSettled {position: position_key, claim: ctx.accounts.claim.key(),
        payout: ctx.accounts.claim.payout, refund: ctx.accounts.claim.refund, price: current_price});
    Ok(())
}

pub fn settle_pro(ctx: Context<SettlePro>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(ctx.accounts.settlement.market == ctx.accounts.market.key() &&
        ctx.accounts.settlement.maturity_at == ctx.accounts.position.maturity &&
        ctx.accounts.settlement.cycle == ctx.accounts.position.cycle &&
        ctx.accounts.position.market == ctx.accounts.market.key() &&
        now >= ctx.accounts.settlement.eligible_at, ErrorCode::InvalidInput);
    let position_key = ctx.accounts.position.key();
    settle_position(&mut ctx.accounts.finance_market, &mut ctx.accounts.position,
        &mut ctx.accounts.claim, ctx.accounts.settlement.price,
        ctx.accounts.settlement.effective_close_at, position_key)?;
    emit!(ProSettled {position: position_key, claim: ctx.accounts.claim.key(),
        payout: ctx.accounts.claim.payout, refund: ctx.accounts.claim.refund,
        price: ctx.accounts.settlement.price});
    Ok(())
}

pub fn claim_pro(ctx: Context<ClaimPro>) -> Result<()> {
    require!(ctx.accounts.claim.owner == ctx.accounts.owner.key() &&
        ctx.accounts.claim.market == ctx.accounts.market.key() &&
        ctx.accounts.claim.position == ctx.accounts.position.key() &&
        ctx.accounts.position.state == PositionState::Settled && !ctx.accounts.claim.paid,
        ErrorCode::Unauthorized);
    let fm = &mut ctx.accounts.finance_market;
    token::require_mint(&ctx.accounts.payment_mint.to_account_info(), Some(ctx.accounts.finance_config.key()))?;
    token::amount(&ctx.accounts.payment_vault.to_account_info(), ctx.accounts.payment_mint.key(), fm.key())?;
    token::amount(&ctx.accounts.owner_payment.to_account_info(), ctx.accounts.payment_mint.key(), ctx.accounts.owner.key())?;
    let due = checked_add(ctx.accounts.claim.payout, ctx.accounts.claim.refund)?;
    require!(fm.other_reserved >= due, ErrorCode::InsufficientCapital);
    if due > 0 {
        let market_key = ctx.accounts.market.key(); let bump = [fm.bump]; let seeds = finance_seeds(&market_key, &bump);
        token::transfer_checked(&ctx.accounts.token_program.to_account_info(), &ctx.accounts.payment_vault.to_account_info(),
            &ctx.accounts.payment_mint.to_account_info(), &ctx.accounts.owner_payment.to_account_info(),
            &fm.to_account_info(), due, &[&seeds])?;
    }
    fm.other_reserved = checked_sub(fm.other_reserved, due)?;
    fm.state_version = checked_add(fm.state_version, 1)?;
    ctx.accounts.claim.paid = true;
    emit!(ProClaimed {claim: ctx.accounts.claim.key(), owner: ctx.accounts.owner.key(), amount: due});
    Ok(())
}

pub fn start_lp_window(ctx: Context<StartLpWindow>) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    let fm = &mut ctx.accounts.finance_market;
    require!(fm.open_positions == 0 && fm.total_shares > 0 &&
        ctx.accounts.market.phase == MarketPhase::Indexed, ErrorCode::WrongPhase);
    lp_price(&ctx.accounts.market, fm, now)?;
    let weekly = current_monday(now)?;
    if fm.current_maturity == 0 {
        require!(weekly > fm.last_lp_maturity || fm.lp_generation != ctx.accounts.market.validity_generation,
            ErrorCode::WrongPhase);
    } else if now < fm.current_maturity {
        // All positions have fixed claims. A genuine validity reset may reopen
        // the LP window; otherwise early reopening requires accepted emergency
        // settlement for the old cycle.
        if fm.lp_generation == ctx.accounts.market.validity_generation {
            require!(ctx.accounts.settlement.owner == &crate::ID, ErrorCode::WrongPhase);
            let bytes = ctx.accounts.settlement.try_borrow_data()?;
            let settlement = SettlementEpoch::try_deserialize(&mut bytes.as_ref())?;
            require!(settlement.cycle == fm.current_cycle && settlement.mode == SettlementMode::Emergency &&
                settlement.effective_close_at <= now, ErrorCode::WrongPhase);
        }
    }
    fm.lp_window_start = now;
    fm.lp_window_end = now.checked_add(LP_DURATION).ok_or(error!(ErrorCode::Overflow))?;
    fm.pro_reopen_at = fm.lp_window_end;
    fm.lp_generation = ctx.accounts.market.validity_generation;
    fm.current_maturity = 0;
    fm.last_lp_maturity = weekly;
    fm.state_version = checked_add(fm.state_version, 1)?;
    emit!(LpWindowOpened {market: fm.market, start: now, end: fm.lp_window_end});
    Ok(())
}

fn lp_context(ctx: &Context<LpTrade>, now: i64, sequence: u64, config_version: u64, state_version: u64) -> Result<(u64, u64)> {
    quote(now, now.saturating_add(30), sequence, config_version, state_version,
        &ctx.accounts.market, &ctx.accounts.config, &ctx.accounts.finance_market)?;
    let fm = &ctx.accounts.finance_market;
    require!(fm.open_positions == 0 && now >= fm.lp_window_start && now < fm.lp_window_end,
        ErrorCode::WrongPhase);
    require!(fm.lp_generation == ctx.accounts.market.validity_generation, ErrorCode::DataUnavailable);
    let current_price = lp_price(&ctx.accounts.market, fm, now)?;
    token::require_mint(&ctx.accounts.payment_mint.to_account_info(), Some(ctx.accounts.finance_config.key()))?;
    let assets = token::amount(&ctx.accounts.payment_vault.to_account_info(), ctx.accounts.payment_mint.key(), fm.key())?;
    token::amount(&ctx.accounts.owner_payment.to_account_info(), ctx.accounts.payment_mint.key(), ctx.accounts.owner.key())?;
    Ok((assets, current_price))
}

pub fn deposit_lp(ctx: Context<LpTrade>, amount: u64, min_shares: u64,
    expected_sequence: u64, expected_config_version: u64, expected_state_version: u64,
    deadline: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(now <= deadline && deadline <= now.saturating_add(30) && amount > 0, ErrorCode::QuoteExpired);
    let (assets, current_price) = lp_context(&ctx, now, expected_sequence,
        expected_config_version, expected_state_version)?;
    let fm = &mut ctx.accounts.finance_market;
    let equity = nav(fm, assets, current_price)?;
    require!(equity > 0 && fm.total_shares > 0, ErrorCode::InsufficientCapital);
    let minted = math_result(math::to_u64(u128::from(amount) * u128::from(fm.total_shares) / u128::from(equity)))?;
    require!(minted > 0 && minted >= min_shares, ErrorCode::Slippage);
    let holding = &mut ctx.accounts.holding;
    require!(holding.owner == Pubkey::default() ||
        (holding.owner == ctx.accounts.owner.key() && holding.market == ctx.accounts.market.key()),
        ErrorCode::Unauthorized);
    token::transfer_checked(&ctx.accounts.token_program.to_account_info(), &ctx.accounts.owner_payment.to_account_info(),
        &ctx.accounts.payment_mint.to_account_info(), &ctx.accounts.payment_vault.to_account_info(),
        &ctx.accounts.owner.to_account_info(), amount, &[])?;
    fm.total_shares = checked_add(fm.total_shares, minted)?;
    holding.market = ctx.accounts.market.key(); holding.owner = ctx.accounts.owner.key();
    holding.shares = checked_add(holding.shares, minted)?;
    solvent(fm, checked_add(assets, amount)?)?;
    fm.state_version = checked_add(fm.state_version, 1)?;
    emit!(LpChanged {market: fm.market, owner: holding.owner, deposited: true,
        amount, shares: minted});
    Ok(())
}

pub fn withdraw_lp(ctx: Context<LpTrade>, shares: u64, min_receipt: u64,
    expected_sequence: u64, expected_config_version: u64, expected_state_version: u64,
    deadline: i64) -> Result<()> {
    let now = Clock::get()?.unix_timestamp;
    require!(now <= deadline && deadline <= now.saturating_add(30) && shares > 0, ErrorCode::QuoteExpired);
    let (assets, current_price) = lp_context(&ctx, now, expected_sequence,
        expected_config_version, expected_state_version)?;
    let fm = &mut ctx.accounts.finance_market;
    let holding = &mut ctx.accounts.holding;
    require!(holding.owner == ctx.accounts.owner.key() && holding.market == fm.market &&
        holding.shares >= shares && fm.total_shares > fm.locked_shares,
        ErrorCode::Unauthorized);
    let equity = nav(fm, assets, current_price)?;
    require!(equity > 0, ErrorCode::InsufficientCapital);
    let payout = math_result(math::to_u64(u128::from(shares) * u128::from(equity) / u128::from(fm.total_shares)))?;
    require!(payout > 0 && payout >= min_receipt && payout <= assets, ErrorCode::Slippage);
    holding.shares = checked_sub(holding.shares, shares)?;
    fm.total_shares = checked_sub(fm.total_shares, shares)?;
    require!(fm.total_shares >= fm.locked_shares, ErrorCode::InsufficientCapital);
    solvent(fm, checked_sub(assets, payout)?)?;
    let market_key = ctx.accounts.market.key(); let bump = [fm.bump]; let seeds = finance_seeds(&market_key, &bump);
    token::transfer_checked(&ctx.accounts.token_program.to_account_info(), &ctx.accounts.payment_vault.to_account_info(),
        &ctx.accounts.payment_mint.to_account_info(), &ctx.accounts.owner_payment.to_account_info(),
        &fm.to_account_info(), payout, &[&seeds])?;
    fm.state_version = checked_add(fm.state_version, 1)?;
    emit!(LpChanged {market: fm.market, owner: holding.owner, deposited: false,
        amount: payout, shares});
    Ok(())
}

#[event] pub struct ProOpened { pub position: Pubkey, pub owner: Pubkey, pub market: Pubkey,
    pub collateral: u64, pub notional: u64, pub maximum_payout: u64, pub maturity: i64 }
#[event] pub struct SettlementAccepted { pub market: Pubkey, pub maturity_at: i64,
    pub candidate_hash: [u8; 32], pub price: u64, pub effective_close_at: i64, pub mode: SettlementMode }
#[event] pub struct ProSettled { pub position: Pubkey, pub claim: Pubkey,
    pub payout: u64, pub refund: u64, pub price: u64 }
#[event] pub struct ProClaimed { pub claim: Pubkey, pub owner: Pubkey, pub amount: u64 }
#[event] pub struct LpWindowOpened { pub market: Pubkey, pub start: i64, pub end: i64 }
#[event] pub struct LpChanged { pub market: Pubkey, pub owner: Pubkey, pub deposited: bool,
    pub amount: u64, pub shares: u64 }

#[event] pub struct FinancialTrade {
    pub market: Pubkey, pub user: Pubkey, pub action: u8,
    pub quantity: u64, pub gross: u64, pub fee: u64, pub price: u64,
}
#[event] pub struct Graduated { pub market: Pubkey, pub contribution: u64, pub assets: u64,
    pub pmax: u64, pub locked_shares: u64 }
