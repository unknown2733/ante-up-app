//! Narrow classic SPL Token CPI boundary. The token crate is deliberately not
//! vendored: these stable instruction layouts are checked against the classic
//! Token Program interface, and every account is validated before a CPI.
use anchor_lang::prelude::*;
use anchor_lang::solana_program::{instruction::{AccountMeta, Instruction}, program::invoke_signed};

pub const TOKEN_ID: Pubkey = pubkey!("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
pub const MINT_LEN: usize = 82;
pub const ACCOUNT_LEN: usize = 165;
pub const DECIMALS: u8 = 6;

pub fn require_program(info: &AccountInfo) -> Result<()> {
    require_keys_eq!(*info.key, TOKEN_ID, crate::ErrorCode::InvalidTokenAccount);
    require!(info.executable, crate::ErrorCode::InvalidTokenAccount);
    Ok(())
}

fn key_at(bytes: &[u8], start: usize) -> Pubkey {
    Pubkey::new_from_array(bytes[start..start + 32].try_into().unwrap())
}

pub fn require_mint(info: &AccountInfo, authority: Option<Pubkey>) -> Result<u64> {
    require_keys_eq!(*info.owner, TOKEN_ID, crate::ErrorCode::InvalidTokenAccount);
    let bytes = info.try_borrow_data()?;
    require!(bytes.len() == MINT_LEN && bytes[45] == 1 && bytes[44] == DECIMALS,
        crate::ErrorCode::InvalidTokenAccount);
    require!(u32::from_le_bytes(bytes[46..50].try_into().unwrap()) == 0,
        crate::ErrorCode::InvalidTokenAccount);
    let tag = u32::from_le_bytes(bytes[0..4].try_into().unwrap());
    match authority {
        Some(expected) => require!(tag == 1 && key_at(&bytes, 4) == expected, crate::ErrorCode::InvalidTokenAccount),
        None => require!(tag == 0, crate::ErrorCode::InvalidTokenAccount),
    }
    Ok(u64::from_le_bytes(bytes[36..44].try_into().unwrap()))
}

pub fn amount(info: &AccountInfo, mint: Pubkey, authority: Pubkey) -> Result<u64> {
    require_keys_eq!(*info.owner, TOKEN_ID, crate::ErrorCode::InvalidTokenAccount);
    let bytes = info.try_borrow_data()?;
    require!(bytes.len() == ACCOUNT_LEN && bytes[108] == 1,
        crate::ErrorCode::InvalidTokenAccount);
    require_keys_eq!(key_at(&bytes, 0), mint, crate::ErrorCode::InvalidTokenAccount);
    require_keys_eq!(key_at(&bytes, 32), authority, crate::ErrorCode::InvalidTokenAccount);
    Ok(u64::from_le_bytes(bytes[64..72].try_into().unwrap()))
}

pub fn initialize_mint2<'info>(program: &AccountInfo<'info>, mint: &AccountInfo<'info>, authority: Pubkey) -> Result<()> {
    require_program(program)?;
    let mut data = vec![20, DECIMALS];
    data.extend_from_slice(authority.as_ref());
    data.push(0); // instruction COption::None is one byte (account state uses four)
    let ix = Instruction {program_id: TOKEN_ID, accounts: vec![AccountMeta::new(*mint.key, false)], data};
    invoke_signed(&ix, &[mint.clone(), program.clone()], &[])?;
    Ok(())
}

pub fn initialize_account3<'info>(program: &AccountInfo<'info>, account: &AccountInfo<'info>,
    mint: &AccountInfo<'info>, authority: Pubkey) -> Result<()> {
    require_program(program)?;
    let mut data = vec![18];
    data.extend_from_slice(authority.as_ref());
    let ix = Instruction {program_id: TOKEN_ID,
        accounts: vec![AccountMeta::new(*account.key, false), AccountMeta::new_readonly(*mint.key, false)], data};
    invoke_signed(&ix, &[account.clone(), mint.clone(), program.clone()], &[])?;
    Ok(())
}

pub fn transfer_checked<'info>(program: &AccountInfo<'info>, source: &AccountInfo<'info>, mint: &AccountInfo<'info>,
    destination: &AccountInfo<'info>, authority: &AccountInfo<'info>, quantity: u64,
    seeds: &[&[&[u8]]]) -> Result<()> {
    require_program(program)?;
    require!(quantity > 0, crate::ErrorCode::InvalidInput);
    let mut data = vec![12];
    data.extend_from_slice(&quantity.to_le_bytes());
    data.push(DECIMALS);
    let ix = Instruction {program_id: TOKEN_ID, accounts: vec![AccountMeta::new(*source.key, false),
        AccountMeta::new_readonly(*mint.key, false), AccountMeta::new(*destination.key, false),
        AccountMeta::new_readonly(*authority.key, true)], data};
    invoke_signed(&ix, &[source.clone(), mint.clone(), destination.clone(), authority.clone(), program.clone()], seeds)?;
    Ok(())
}

pub fn mint_to_checked<'info>(program: &AccountInfo<'info>, mint: &AccountInfo<'info>,
    destination: &AccountInfo<'info>, authority: &AccountInfo<'info>, quantity: u64,
    seeds: &[&[&[u8]]]) -> Result<()> {
    require_program(program)?;
    require!(quantity > 0, crate::ErrorCode::InvalidInput);
    let mut data = vec![14];
    data.extend_from_slice(&quantity.to_le_bytes());
    data.push(DECIMALS);
    let ix = Instruction {program_id: TOKEN_ID, accounts: vec![AccountMeta::new(*mint.key, false),
        AccountMeta::new(*destination.key, false), AccountMeta::new_readonly(*authority.key, true)], data};
    invoke_signed(&ix, &[mint.clone(), destination.clone(), authority.clone(), program.clone()], seeds)?;
    Ok(())
}

pub fn revoke_mint<'info>(program: &AccountInfo<'info>, mint: &AccountInfo<'info>,
    authority: &AccountInfo<'info>, seeds: &[&[&[u8]]]) -> Result<()> {
    require_program(program)?;
    let mut data = vec![6, 0]; // SetAuthority, MintTokens
    data.push(0); // instruction COption::None
    let ix = Instruction {program_id: TOKEN_ID,
        accounts: vec![AccountMeta::new(*mint.key, false), AccountMeta::new_readonly(*authority.key, true)], data};
    invoke_signed(&ix, &[mint.clone(), authority.clone(), program.clone()], seeds)?;
    Ok(())
}
