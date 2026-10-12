use anchor_lang::prelude::*;
use ante_up_math::free_return;
mod token;
mod finance;
pub use finance::*;

// Devnet program identity. Deployment key is stored outside the source checkout.
declare_id!("FrMATpA81wUMYsZufQkew9K5MW2AC8rgdYQ2wUM6KDKr");

const DAY: i64 = 86_400;
const STALE_AFTER: i64 = 600;
const WALLET_LIMIT: usize = 6;
const GLOBAL_LIMIT: usize = 100;
const OUTSTANDING_LIMIT: u16 = 200;
const FORMULA_BYTES: [u8; 16] = *b"h3-d7-q12-v1\0\0\0\0";

#[program]
pub mod ante_up {
    use super::*;

    pub fn initialize_finance(ctx: Context<InitializeFinance>, faucet_amount: u64,
        faucet_cooldown: i64, faucet_total_limit: u64) -> Result<()> {
        finance::initialize_finance(ctx, faucet_amount, faucet_cooldown, faucet_total_limit)
    }
    pub fn configure_faucet(ctx: Context<ConfigureFaucet>, amount: u64, cooldown: i64, total_limit: u64) -> Result<()> {
        finance::configure_faucet(ctx, amount, cooldown, total_limit)
    }
    pub fn claim_faucet(ctx: Context<ClaimFaucet>) -> Result<()> { finance::claim_faucet(ctx) }
    pub fn register_financial_market(ctx: Context<RegisterFinancialMarket>, market_id: [u8; 32],
        query_hash: [u8; 32], query_version: u64) -> Result<()> {
        finance::register_financial_market(ctx, market_id, query_hash, query_version)
    }
    pub fn curve_buy(ctx: Context<CurveTrade>, quantity: u64, max_payment: u64,
        expected_sequence: u64, expected_config_version: u64, expected_state_version: u64,
        deadline: i64) -> Result<()> {
        finance::curve_buy(ctx, quantity, max_payment, expected_sequence, expected_config_version, expected_state_version, deadline)
    }
    pub fn curve_sell(ctx: Context<CurveTrade>, quantity: u64, min_receipt: u64,
        expected_sequence: u64, expected_config_version: u64, expected_state_version: u64,
        deadline: i64) -> Result<()> {
        finance::curve_sell(ctx, quantity, min_receipt, expected_sequence, expected_config_version, expected_state_version, deadline)
    }
    pub fn graduate(ctx: Context<Graduate>, expected_sequence: u64, expected_config_version: u64,
        expected_state_version: u64, deadline: i64, max_contribution: u64) -> Result<()> {
        finance::graduate(ctx, expected_sequence, expected_config_version, expected_state_version, deadline, max_contribution)
    }
    pub fn spot_buy(ctx: Context<SpotTrade>, quantity: u64, max_payment: u64,
        expected_sequence: u64, expected_config_version: u64, expected_state_version: u64, deadline: i64) -> Result<()> {
        finance::spot_buy(ctx, quantity, max_payment, expected_sequence, expected_config_version, expected_state_version, deadline)
    }
    pub fn spot_sell(ctx: Context<SpotTrade>, quantity: u64, min_receipt: u64,
        expected_sequence: u64, expected_config_version: u64, expected_state_version: u64, deadline: i64) -> Result<()> {
        finance::spot_sell(ctx, quantity, min_receipt, expected_sequence, expected_config_version, expected_state_version, deadline)
    }
    pub fn open_pro(ctx: Context<OpenPro>, position_id: u64, collateral: u64, leverage_bps: u64,
        direction: PositionDirection, max_payment: u64, expected_sequence: u64,
        expected_config_version: u64, expected_state_version: u64, deadline: i64) -> Result<()> {
        finance::open_pro(ctx, position_id, collateral, leverage_bps, direction, max_payment,
            expected_sequence, expected_config_version, expected_state_version, deadline)
    }
    pub fn accept_settlement(ctx: Context<AcceptSettlement>, epoch: u64, maturity_at: i64,
        candidate_hash: [u8; 32], evidence_hash: [u8; 32], mode: SettlementMode,
        eligible_at: i64, effective_close_at: i64, outage_started_at: i64,
        settlement_price: u64, activity_now_q12: u64, activity_7d_q12: u64,
        query_version: u64, expected_config_version: u64) -> Result<()> {
        finance::accept_settlement(ctx, epoch, maturity_at, candidate_hash, evidence_hash, mode,
            eligible_at, effective_close_at, outage_started_at, settlement_price,
            activity_now_q12, activity_7d_q12, query_version, expected_config_version)
    }
    pub fn close_pro(ctx: Context<ClosePro>, min_receipt: u64, expected_sequence: u64,
        expected_config_version: u64, expected_state_version: u64, deadline: i64) -> Result<()> {
        finance::close_pro(ctx, min_receipt, expected_sequence, expected_config_version, expected_state_version, deadline)
    }
    pub fn settle_pro(ctx: Context<SettlePro>) -> Result<()> { finance::settle_pro(ctx) }
    pub fn claim_pro(ctx: Context<ClaimPro>) -> Result<()> { finance::claim_pro(ctx) }
    pub fn start_lp_window(ctx: Context<StartLpWindow>) -> Result<()> { finance::start_lp_window(ctx) }
    pub fn deposit_lp(ctx: Context<LpTrade>, amount: u64, min_shares: u64,
        expected_sequence: u64, expected_config_version: u64, expected_state_version: u64, deadline: i64) -> Result<()> {
        finance::deposit_lp(ctx, amount, min_shares, expected_sequence,
            expected_config_version, expected_state_version, deadline)
    }
    pub fn withdraw_lp(ctx: Context<LpTrade>, shares: u64, min_receipt: u64,
        expected_sequence: u64, expected_config_version: u64, expected_state_version: u64, deadline: i64) -> Result<()> {
        finance::withdraw_lp(ctx, shares, min_receipt, expected_sequence,
            expected_config_version, expected_state_version, deadline)
    }

    pub fn initialize(ctx: Context<Initialize>, publisher: Pubkey, proof_authority: Pubkey, formula_version: [u8; 16]) -> Result<()> {
        require!(publisher != Pubkey::default() && proof_authority != Pubkey::default(), ErrorCode::InvalidInput);
        require!(formula_version == FORMULA_BYTES, ErrorCode::VersionMismatch);
        let c = &mut ctx.accounts.config;
        c.admin = ctx.accounts.admin.key();
        c.publisher = publisher;
        c.proof_authority = proof_authority;
        c.formula_version = formula_version;
        c.config_version = 1;
        let g = &mut ctx.accounts.admission;
        g.admin = c.admin;
        g.open = false; // The operator must establish budget/storage gates before enabling intake.
        g.outstanding = 0;
        g.recent = [0; GLOBAL_LIMIT];
        Ok(())
    }

    pub fn set_admission_gate(ctx: Context<SetAdmissionGate>, open: bool) -> Result<()> {
        ctx.accounts.admission.open = open;
        ctx.accounts.config.config_version = ctx.accounts.config.config_version.checked_add(1).ok_or(ErrorCode::Overflow)?;
        Ok(())
    }

    pub fn register_market(ctx: Context<RegisterMarket>, market_id: [u8; 32], query_hash: [u8; 32], query_version: u64) -> Result<()> {
        require!(query_version > 0 && market_id != [0; 32] && query_hash != [0; 32], ErrorCode::InvalidInput);
        let m = &mut ctx.accounts.market;
        m.id = market_id;
        m.admin = ctx.accounts.admin.key();
        m.query_hash = query_hash;
        m.query_version = query_version;
        m.phase = MarketPhase::Curve;
        m.data_status = DataStatus::Preparing;
        m.admission = TradingAdmission { state: AdmissionState::Blocked, recovery_count: 0, reason: Some(AdmissionReason::DataNotReady) };
        m.latest_sequence = 0;
        m.validity_generation = 0;
        Ok(())
    }

    pub fn publish_snapshot(ctx: Context<PublishSnapshot>, sequence: u64, input: SnapshotInput) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let m = &mut ctx.accounts.market;
        require!(sequence == m.latest_sequence.checked_add(1).ok_or(ErrorCode::Overflow)?, ErrorCode::VersionMismatch);
        require!(input.query_version == m.query_version && input.query_hash == m.query_hash, ErrorCode::VersionMismatch);
        require!(input.config_version == ctx.accounts.config.config_version, ErrorCode::VersionMismatch);
        require!(input.formula_version == ctx.accounts.config.formula_version, ErrorCode::VersionMismatch);
        require!(input.data_through <= now && input.data_through >= 0, ErrorCode::InvalidInput);
        require!(input.data_through >= m.latest_data_through, ErrorCode::VersionMismatch);
        require!(input.payload_hash != [0; 32] && input.evidence_hash != [0; 32], ErrorCode::InvalidInput);
        if matches!(input.data_status, DataStatus::Valid | DataStatus::LowActivity) {
            require!(input.activity_now_q12.is_some() && input.activity_7d_q12.is_some(), ErrorCode::InvalidInput);
        }
        match input.admission.state {
            AdmissionState::Open => require!(input.data_status == DataStatus::Valid && (input.admission.recovery_count == 0 || input.admission.recovery_count == 2) && input.admission.reason.is_none(), ErrorCode::InvalidInput),
            AdmissionState::Recovering => require!(input.data_status == DataStatus::Valid && input.admission.recovery_count == 1 && input.admission.reason.is_some(), ErrorCode::InvalidInput),
            AdmissionState::Blocked => require!(input.admission.recovery_count == 0 && input.admission.reason.is_some(), ErrorCode::InvalidInput),
        }
        if input.data_status == DataStatus::LowActivity {
            require!(input.admission.state == AdmissionState::Blocked && input.admission.reason == Some(AdmissionReason::LowActivity), ErrorCode::InvalidInput);
        }
        let previous_valid = (m.data_status == DataStatus::LowActivity ||
            (m.data_status == DataStatus::Valid && m.admission.state == AdmissionState::Open)) &&
            m.latest_now_q12.is_some() && m.latest_7d_q12.unwrap_or(0) > 0;
        let incoming_valid = (input.data_status == DataStatus::LowActivity ||
            (input.data_status == DataStatus::Valid && input.admission.state == AdmissionState::Open)) &&
            input.activity_now_q12.is_some() && input.activity_7d_q12.unwrap_or(0) > 0 &&
            now.saturating_sub(input.data_through) < STALE_AFTER;
        if !previous_valid || !incoming_valid ||
            previous_snapshot_expired(m.latest_sequence, m.latest_data_through, now) {
            m.validity_generation = m.validity_generation.checked_add(1).ok_or(ErrorCode::Overflow)?;
        }
        let s = &mut ctx.accounts.snapshot;
        s.market = m.key();
        s.sequence = sequence;
        s.payload_hash = input.payload_hash;
        s.evidence_hash = input.evidence_hash;
        s.query_hash = input.query_hash;
        s.query_version = input.query_version;
        s.config_version = input.config_version;
        s.formula_version = input.formula_version;
        s.data_through = input.data_through;
        s.published_at = now;
        s.activity_now_q12 = input.activity_now_q12;
        s.activity_7d_q12 = input.activity_7d_q12;
        s.data_status = input.data_status;
        s.admission = input.admission;
        m.latest_sequence = sequence;
        m.latest_hash = input.payload_hash;
        m.latest_data_through = input.data_through;
        m.latest_now_q12 = input.activity_now_q12;
        m.latest_7d_q12 = input.activity_7d_q12;
        m.data_status = input.data_status;
        m.admission = input.admission;
        emit!(SnapshotPublished { market: m.key(), sequence, payload_hash: input.payload_hash });
        Ok(())
    }

    pub fn open_free(ctx: Context<OpenFree>, record_id: u64) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        require!(now > 0, ErrorCode::InvalidInput);
        let g = &mut ctx.accounts.admission;
        require!(g.open, ErrorCode::LimitReached);
        require!(g.outstanding < OUTSTANDING_LIMIT, ErrorCode::LimitReached);
        require!(recent_count(&g.recent, now) < GLOBAL_LIMIT, ErrorCode::LimitReached);
        let w = &mut ctx.accounts.wallet_stats;
        if w.wallet == Pubkey::default() { w.wallet = ctx.accounts.owner.key(); }
        require_keys_eq!(w.wallet, ctx.accounts.owner.key(), ErrorCode::Unauthorized);
        require!(w.open_count < 3 && recent_count(&w.recent, now) < WALLET_LIMIT, ErrorCode::LimitReached);
        let slot = &mut ctx.accounts.wallet_market;
        if slot.wallet == Pubkey::default() {
            slot.wallet = ctx.accounts.owner.key();
            slot.market = ctx.accounts.market.key();
        }
        require_keys_eq!(slot.wallet, ctx.accounts.owner.key(), ErrorCode::Unauthorized);
        require_keys_eq!(slot.market, ctx.accounts.market.key(), ErrorCode::Unauthorized);
        require!(!slot.active, ErrorCode::LimitReached);
        insert_recent(&mut g.recent, now)?;
        insert_recent(&mut w.recent, now)?;
        g.outstanding = g.outstanding.checked_add(1).ok_or(ErrorCode::Overflow)?;
        w.open_count = w.open_count.checked_add(1).ok_or(ErrorCode::Overflow)?;
        slot.active = true;
        let r = &mut ctx.accounts.record;
        r.id = record_id;
        r.owner = ctx.accounts.owner.key();
        r.market = ctx.accounts.market.key();
        r.state = FreeState::Open;
        r.entry = point(&ctx.accounts.market, now, clock.slot, false);
        r.opened_at = now;
        emit!(FreeOpened { record: r.key(), record_id: r.id, owner: r.owner, market: r.market, entry: r.entry });
        Ok(())
    }

    pub fn close_free(ctx: Context<CloseFree>) -> Result<()> {
        let clock = Clock::get()?;
        let now = clock.unix_timestamp;
        let r = &mut ctx.accounts.record;
        require!(r.state == FreeState::Open, ErrorCode::AlreadyExecuted);
        let exit = point(&ctx.accounts.market, now, clock.slot, true);
        r.exit = exit;
        r.closed_at = now;
        if r.entry.usable && exit.usable {
            let ret = free_return(r.entry.h_num, r.entry.h_den, exit.h_num, exit.h_den).map_err(|_| ErrorCode::InvalidDenominator)?;
            r.state = FreeState::ClosedResult;
            r.result_negative = ret.negative;
            r.result_num = ret.numerator;
            r.result_den = ret.denominator;
        } else {
            r.state = FreeState::ClosedNa;
            r.na_reason = if !r.entry.usable { r.entry.reason } else { exit.reason };
        }
        let w = &mut ctx.accounts.wallet_stats;
        w.open_count = w.open_count.checked_sub(1).ok_or(ErrorCode::Overflow)?;
        ctx.accounts.wallet_market.active = false;
        // Outstanding proof duty deliberately remains until proof completion.
        emit!(FreeClosed {
            record: r.key(), record_id: r.id, owner: r.owner, market: r.market,
            state: r.state, entry: r.entry, exit,
            result_negative: r.result_negative, result_num: r.result_num,
            result_den: r.result_den, na_reason: r.na_reason,
        });
        Ok(())
    }

    pub fn complete_proof(ctx: Context<CompleteProof>, proof_hash: [u8; 32]) -> Result<()> {
        require!(proof_hash != [0; 32], ErrorCode::InvalidInput);
        let r = &mut ctx.accounts.record;
        require!(r.state != FreeState::Open && !r.proof_complete, ErrorCode::AlreadyExecuted);
        r.proof_hash = proof_hash;
        r.proof_complete = true;
        ctx.accounts.admission.outstanding = ctx.accounts.admission.outstanding.checked_sub(1).ok_or(ErrorCode::Overflow)?;
        emit!(ProofCompleted { record: r.key(), record_id: r.id, owner: r.owner, market: r.market, proof_hash });
        Ok(())
    }
}

fn previous_snapshot_expired(sequence: u64, data_through: i64, now: i64) -> bool {
    sequence > 0 && now.saturating_sub(data_through) >= STALE_AFTER
}

#[cfg(test)]
mod continuity_tests {
    use super::previous_snapshot_expired;

    #[test]
    fn fresh_replacement_still_records_expired_previous_snapshot() {
        // The incoming observation may be fresh while the old one spent time stale.
        assert!(!previous_snapshot_expired(1, 1_000, 1_599));
        assert!(previous_snapshot_expired(1, 1_000, 1_600));
        assert!(previous_snapshot_expired(1, 1_000, 1_900));
        assert!(!previous_snapshot_expired(0, 0, 1_900));
    }
}

fn recent_count<const N: usize>(items: &[i64; N], now: i64) -> usize {
    items.iter().filter(|&&t| t > 0 && now.saturating_sub(t) < DAY).count()
}
fn insert_recent<const N: usize>(items: &mut [i64; N], now: i64) -> Result<()> {
    let index = items.iter().position(|&t| t == 0 || now.saturating_sub(t) >= DAY).ok_or(ErrorCode::LimitReached)?;
    items[index] = now;
    Ok(())
}
fn point(m: &Market, now: i64, slot: u64, allow_zero: bool) -> RecordPoint {
    let mut p = RecordPoint {
        sequence: m.latest_sequence, payload_hash: m.latest_hash, executed_at: now, slot,
        h_num: 0, h_den: 0, usable: false, reason: NaReason::DataNotReady,
    };
    if m.latest_sequence == 0 { return p }
    if !matches!(m.data_status, DataStatus::Valid | DataStatus::LowActivity) { p.reason = NaReason::DataUnavailable; return p }
    if m.latest_data_through > now || now.saturating_sub(m.latest_data_through) >= STALE_AFTER {
        p.reason = NaReason::DataStale; return p
    }
    if let (Some(s), Some(d)) = (m.latest_now_q12, m.latest_7d_q12) {
        if d == 0 { p.reason = NaReason::InvalidDenominator; return p }
        let cap = u128::from(d) * 5;
        // The cast is reached only when cap < s, so cap fits in u64.
        let num = if u128::from(s) > cap { cap as u64 } else { s };
        if num == 0 && !allow_zero { p.reason = NaReason::ZeroEntry; return p }
        p.h_num = num; p.h_den = d; p.usable = true; p.reason = NaReason::None;
    }
    p
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct SnapshotInput {
    pub query_hash: [u8; 32], pub query_version: u64, pub config_version: u64,
    pub formula_version: [u8; 16], pub data_through: i64,
    pub activity_now_q12: Option<u64>, pub activity_7d_q12: Option<u64>,
    pub data_status: DataStatus, pub admission: TradingAdmission,
    pub evidence_hash: [u8; 32], pub payload_hash: [u8; 32],
}

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(init, payer = admin, space = 8 + 128, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    #[account(init, payer = admin, space = 8 + 1024, seeds = [b"admission"], bump)]
    pub admission: Account<'info, Admission>,
    #[account(mut)] pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct SetAdmissionGate<'info> {
    #[account(mut, seeds = [b"config"], bump, has_one = admin)] pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"admission"], bump, constraint = admission.admin == admin.key() @ ErrorCode::Unauthorized)] pub admission: Account<'info, Admission>,
    pub admin: Signer<'info>,
}
#[derive(Accounts)]
#[instruction(market_id: [u8; 32])]
pub struct RegisterMarket<'info> {
    #[account(seeds = [b"config"], bump, has_one = admin)] pub config: Account<'info, Config>,
    #[account(init, payer = admin, space = 8 + 512, seeds = [b"market", market_id.as_ref()], bump)] pub market: Account<'info, Market>,
    #[account(mut)] pub admin: Signer<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(sequence: u64)]
pub struct PublishSnapshot<'info> {
    #[account(seeds = [b"config"], bump, has_one = publisher)] pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"market", market.id.as_ref()], bump)] pub market: Account<'info, Market>,
    #[account(init, payer = publisher, space = 8 + 256, seeds = [b"snapshot", market.key().as_ref(), &sequence.to_le_bytes()], bump)] pub snapshot: Account<'info, Snapshot>,
    #[account(mut)] pub publisher: Signer<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
#[instruction(record_id: u64)]
pub struct OpenFree<'info> {
    #[account(seeds = [b"market", market.id.as_ref()], bump)] pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"admission"], bump)] pub admission: Account<'info, Admission>,
    #[account(init_if_needed, payer = owner, space = 8 + 128, seeds = [b"free-wallet", owner.key().as_ref()], bump)] pub wallet_stats: Account<'info, WalletStats>,
    #[account(init_if_needed, payer = owner, space = 8 + 96, seeds = [b"free-slot", owner.key().as_ref(), market.key().as_ref()], bump)] pub wallet_market: Account<'info, WalletMarket>,
    #[account(init, payer = owner, space = 8 + 512, seeds = [b"free", market.key().as_ref(), owner.key().as_ref(), &record_id.to_le_bytes()], bump)] pub record: Account<'info, FreeRecord>,
    #[account(mut)] pub owner: Signer<'info>,
    pub system_program: Program<'info, System>,
}
#[derive(Accounts)]
pub struct CloseFree<'info> {
    #[account(seeds = [b"market", market.id.as_ref()], bump)] pub market: Account<'info, Market>,
    #[account(mut, seeds = [b"free", market.key().as_ref(), owner.key().as_ref(), &record.id.to_le_bytes()], bump, has_one = owner, has_one = market)] pub record: Account<'info, FreeRecord>,
    #[account(mut, seeds = [b"free-wallet", owner.key().as_ref()], bump, constraint = wallet_stats.wallet == owner.key() @ ErrorCode::Unauthorized)] pub wallet_stats: Account<'info, WalletStats>,
    #[account(mut, seeds = [b"free-slot", owner.key().as_ref(), market.key().as_ref()], bump, constraint = wallet_market.active && wallet_market.wallet == owner.key() && wallet_market.market == market.key() @ ErrorCode::Unauthorized)] pub wallet_market: Account<'info, WalletMarket>,
    pub owner: Signer<'info>,
}
#[derive(Accounts)]
pub struct CompleteProof<'info> {
    #[account(seeds = [b"config"], bump, has_one = proof_authority)] pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"admission"], bump)] pub admission: Account<'info, Admission>,
    #[account(mut, seeds = [b"free", record.market.as_ref(), record.owner.as_ref(), &record.id.to_le_bytes()], bump)] pub record: Account<'info, FreeRecord>,
    pub proof_authority: Signer<'info>,
}

#[account] pub struct Config { pub admin: Pubkey, pub publisher: Pubkey, pub proof_authority: Pubkey, pub formula_version: [u8; 16], pub config_version: u64 }
#[account] pub struct Admission { pub admin: Pubkey, pub open: bool, pub outstanding: u16, pub recent: [i64; GLOBAL_LIMIT] }
#[account] pub struct WalletStats { pub wallet: Pubkey, pub open_count: u8, pub recent: [i64; WALLET_LIMIT] }
#[account] pub struct WalletMarket { pub wallet: Pubkey, pub market: Pubkey, pub active: bool }
#[account] pub struct Market {
    pub id: [u8; 32], pub admin: Pubkey, pub query_hash: [u8; 32], pub query_version: u64,
    pub phase: MarketPhase, pub data_status: DataStatus, pub admission: TradingAdmission, pub latest_sequence: u64,
    pub latest_hash: [u8; 32], pub latest_data_through: i64,
    pub latest_now_q12: Option<u64>, pub latest_7d_q12: Option<u64>, pub validity_generation: u64,
}
#[account] pub struct Snapshot {
    pub market: Pubkey, pub sequence: u64, pub payload_hash: [u8; 32], pub evidence_hash: [u8; 32],
    pub query_hash: [u8; 32],
    pub query_version: u64, pub config_version: u64, pub formula_version: [u8; 16],
    pub data_through: i64, pub published_at: i64, pub activity_now_q12: Option<u64>,
    pub activity_7d_q12: Option<u64>, pub data_status: DataStatus, pub admission: TradingAdmission,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum MarketPhase { Curve, GraduationWait, Indexed }
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum DataStatus { Preparing, Valid, LowActivity, Outage }
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionState { Blocked, Recovering, Open }
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum AdmissionReason {
    WrongPhase, DataNotReady, DataStale, LowActivity, InvalidDenominator,
    PrecisionUnderflow, VersionMismatch, RequoteRequired, LimitReached,
    InsufficientFreeCapital, LpWindowClosed, AlreadyExecuted, Unauthorized,
    PendingConfirmation, BudgetExhausted, StorageBacklog, InvalidInput,
}
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub struct TradingAdmission { pub state: AdmissionState, pub recovery_count: u8, pub reason: Option<AdmissionReason> }
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum FreeState { Open, ClosedResult, ClosedNa }
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy, PartialEq, Eq)]
pub enum NaReason { None, DataNotReady, DataUnavailable, DataStale, InvalidDenominator, ZeroEntry, PrecisionOverflow }
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Copy)]
pub struct RecordPoint {
    pub sequence: u64, pub payload_hash: [u8; 32], pub executed_at: i64, pub slot: u64,
    pub h_num: u64, pub h_den: u64, pub usable: bool, pub reason: NaReason,
}
#[account] pub struct FreeRecord {
    pub id: u64, pub owner: Pubkey, pub market: Pubkey, pub state: FreeState,
    pub opened_at: i64, pub closed_at: i64, pub entry: RecordPoint, pub exit: RecordPoint,
    pub result_negative: bool, pub result_num: u128, pub result_den: u128, pub na_reason: NaReason,
    pub proof_complete: bool, pub proof_hash: [u8; 32],
}
#[event] pub struct SnapshotPublished { pub market: Pubkey, pub sequence: u64, pub payload_hash: [u8; 32] }
#[event] pub struct FreeOpened {
    pub record: Pubkey, pub record_id: u64, pub owner: Pubkey, pub market: Pubkey,
    pub entry: RecordPoint,
}
#[event] pub struct FreeClosed {
    pub record: Pubkey, pub record_id: u64, pub owner: Pubkey, pub market: Pubkey,
    pub state: FreeState, pub entry: RecordPoint, pub exit: RecordPoint,
    pub result_negative: bool, pub result_num: u128, pub result_den: u128,
    pub na_reason: NaReason,
}
#[event] pub struct ProofCompleted {
    pub record: Pubkey, pub record_id: u64, pub owner: Pubkey, pub market: Pubkey,
    pub proof_hash: [u8; 32],
}

#[error_code]
pub enum ErrorCode {
    #[msg("Invalid input")] InvalidInput,
    #[msg("Wrong market phase")] WrongPhase,
    #[msg("Version mismatch")] VersionMismatch,
    #[msg("Limit reached or admission gate closed")] LimitReached,
    #[msg("Action already executed")] AlreadyExecuted,
    #[msg("Unauthorized")] Unauthorized,
    #[msg("Invalid denominator")] InvalidDenominator,
    #[msg("Arithmetic overflow")] Overflow,
    #[msg("Invalid SPL Token account or mint")] InvalidTokenAccount,
    #[msg("Quote expired or has an unsafe deadline")] QuoteExpired,
    #[msg("Slippage bound was not met")] Slippage,
    #[msg("Price data unavailable or stale")] DataUnavailable,
    #[msg("Insufficient reserved capital")] InsufficientCapital,
}
