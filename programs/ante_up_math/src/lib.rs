//! Exact integer calculations for the A contract v0.1. All amounts are six-decimal atoms.
//! Overflow, underflow and invalid denominators reject the calculation.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MathError { InvalidInput, InvalidDenominator, PrecisionUnderflow, Overflow }
pub type Result<T> = core::result::Result<T, MathError>;
pub const UNIT: u128 = 1_000_000;

/// Minimal unsigned 256-bit integer for the three-u64-factor price numerator.
/// This avoids intermediate truncation and keeps the deployed arithmetic dependency-free.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct U256([u64; 4]);
impl Ord for U256 {
    fn cmp(&self, other: &Self) -> core::cmp::Ordering {
        for i in (0..4).rev() {
            match self.0[i].cmp(&other.0[i]) {
                core::cmp::Ordering::Equal => continue,
                order => return order,
            }
        }
        core::cmp::Ordering::Equal
    }
}
impl PartialOrd for U256 {
    fn partial_cmp(&self, other: &Self) -> Option<core::cmp::Ordering> { Some(self.cmp(other)) }
}
impl U256 {
    const ZERO: Self = Self([0; 4]);
    fn from_u64(x: u64) -> Self { Self([x, 0, 0, 0]) }
    fn mul_u64(self, x: u64) -> Result<Self> {
        let mut out = [0; 4];
        let mut carry = 0u128;
        for (i, limb) in self.0.iter().enumerate() {
            let v = u128::from(*limb) * u128::from(x) + carry;
            out[i] = v as u64;
            carry = v >> 64;
        }
        if carry != 0 { return Err(MathError::Overflow) }
        Ok(Self(out))
    }
    fn bit(self, i: usize) -> bool { (self.0[i / 64] >> (i % 64)) & 1 != 0 }
    fn set_bit(&mut self, i: usize) { self.0[i / 64] |= 1u64 << (i % 64); }
    fn shl1(self) -> Result<Self> {
        if self.bit(255) { return Err(MathError::Overflow) }
        let mut out = [0; 4];
        let mut carry = 0;
        for (i, limb) in self.0.iter().enumerate() {
            out[i] = (limb << 1) | carry;
            carry = limb >> 63;
        }
        Ok(Self(out))
    }
    fn sub(self, rhs: Self) -> Result<Self> {
        if self < rhs { return Err(MathError::InvalidInput) }
        let mut out = [0; 4];
        let mut borrow = 0u128;
        for i in 0..4 {
            let left = u128::from(self.0[i]);
            let right = u128::from(rhs.0[i]) + borrow;
            out[i] = left.wrapping_sub(right) as u64;
            borrow = u128::from(left < right);
        }
        Ok(Self(out))
    }
    fn div_rem(self, d: Self) -> Result<(Self, Self)> {
        if d == Self::ZERO { return Err(MathError::InvalidDenominator) }
        let mut q = Self::ZERO;
        let mut rem = Self::ZERO;
        for i in (0..256).rev() {
            rem = rem.shl1()?;
            if self.bit(i) { rem.0[0] |= 1 }
            if rem >= d { rem = rem.sub(d)?; q.set_bit(i) }
        }
        Ok((q, rem))
    }
    fn as_u64(self) -> Result<u64> {
        if self.0[1..].iter().any(|&v| v != 0) { return Err(MathError::Overflow) }
        Ok(self.0[0])
    }
}

fn mul(a: u128, b: u128) -> Result<u128> { a.checked_mul(b).ok_or(MathError::Overflow) }
fn add(a: u128, b: u128) -> Result<u128> { a.checked_add(b).ok_or(MathError::Overflow) }
fn sub(a: u128, b: u128) -> Result<u128> { a.checked_sub(b).ok_or(MathError::InvalidInput) }
pub fn ceil_div(n: u128, d: u128) -> Result<u128> {
    if d == 0 { return Err(MathError::InvalidDenominator) }
    // This form does not overflow at u128::MAX.
    Ok(n / d + u128::from(n % d != 0))
}
pub fn to_u64(n: u128) -> Result<u64> { u64::try_from(n).map_err(|_| MathError::Overflow) }

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Price { pub price: u64, pub maximum: u64 }
pub fn index_price(pg: u64, sg: u64, dg: u64, s: u64, d: u64) -> Result<Price> {
    if pg == 0 || sg == 0 || dg == 0 || d == 0 { return Err(MathError::InvalidDenominator) }
    if U256::from_u64(sg) >= U256::from_u64(dg).mul_u64(5)? { return Err(MathError::InvalidInput) }
    let cap = U256::from_u64(d).mul_u64(5)?;
    let capped = U256::from_u64(s).min(cap).as_u64()?;
    let numerator = U256::from_u64(pg).mul_u64(dg)?.mul_u64(capped)?;
    let denominator = U256::from_u64(sg).mul_u64(d)?;
    let (price, _) = numerator.div_rem(denominator)?;
    if s > 0 && price == U256::ZERO { return Err(MathError::PrecisionUnderflow) }
    let max_numerator = U256::from_u64(pg).mul_u64(dg)?.mul_u64(5)?;
    let (max_floor, max_remainder) = max_numerator.div_rem(U256::from_u64(sg))?;
    let maximum = max_floor.as_u64()?.checked_add(u64::from(max_remainder != U256::ZERO)).ok_or(MathError::Overflow)?;
    Ok(Price { price: price.as_u64()?, maximum })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side { Buy, Sell }
pub fn curve_gross(q0: u64, q1: u64, side: Side) -> Result<u64> {
    let limit = 1000 * UNIT;
    if u128::from(q0) > limit || u128::from(q1) > limit ||
        !matches!((side, q0.cmp(&q1)), (Side::Buy, core::cmp::Ordering::Less) | (Side::Sell, core::cmp::Ordering::Greater)) {
        return Err(MathError::InvalidInput)
    }
    let lo = u128::from(q0.min(q1)); let hi = u128::from(q0.max(q1));
    let den = 10_000 * UNIT;
    let num = add(mul(sub(hi, lo)?, den)?, sub(mul(hi, hi)?, mul(lo, lo)?)?)?;
    to_u64(if side == Side::Buy { ceil_div(num, den)? } else { num / den })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Direction { Long, Short }
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Pro { pub notional: u64, pub payout: u64, pub reserve: u64, pub capital: u64 }
pub fn pro(c: u64, leverage_bps: u64, p0: u64, p: u64, maximum: u64, direction: Direction) -> Result<Pro> {
    if c == 0 || !(10_000..=50_000).contains(&leverage_bps) || p0 == 0 || p0 > maximum || p > maximum { return Err(MathError::InvalidInput) }
    let n = mul(c.into(), leverage_bps.into())? / 10_000;
    let base = mul(c.into(), p0.into())?;
    let (gain, loss) = match (direction, p >= p0) {
        (Direction::Long, true) | (Direction::Short, false) => (mul(n, u128::from(p.abs_diff(p0)))?, 0),
        _ => (0, mul(n, u128::from(p.abs_diff(p0)))?),
    };
    let payout = if loss >= base { 0 } else { add(base, gain)? - loss } / u128::from(p0);
    let reserve = match direction {
        Direction::Long => ceil_div(add(base, mul(n, u128::from(maximum - p0))?)?, p0.into())?,
        Direction::Short => add(c.into(), n)?,
    };
    Ok(Pro { notional: to_u64(n)?, payout: to_u64(payout)?, reserve: to_u64(reserve)?, capital: to_u64(sub(reserve, c.into())?)? })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TradeFee { pub total: u64, pub protocol: u64, pub vault: u64 }
pub fn trade_fee(gross: u64) -> Result<TradeFee> {
    let total = to_u64(ceil_div(mul(gross.into(), 10)?, 10_000)?)?;
    let protocol = total / 5;
    Ok(TradeFee { total, protocol, vault: total - protocol })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TimeFee { pub prepaid: u64, pub earned: u64, pub refund: u64 }
fn time_component(base: u64, bps: u128, duration: u64, elapsed: u64) -> Result<TimeFee> {
    let den = 10_000 * 86_400;
    let prepaid = ceil_div(mul(mul(base.into(), bps)?, duration.into())?, den)?;
    let earned = if elapsed >= duration { prepaid } else { mul(mul(base.into(), bps)?, elapsed.into())? / den };
    Ok(TimeFee { prepaid: to_u64(prepaid)?, earned: to_u64(earned)?, refund: to_u64(prepaid - earned)? })
}
pub fn time_fee(capital: u64, notional: u64, duration: u64, elapsed: u64) -> Result<TimeFee> {
    let a = time_component(capital, 2, duration, elapsed)?;
    let b = time_component(notional, 5, duration, elapsed)?;
    let prepaid = a.prepaid.checked_add(b.prepaid).ok_or(MathError::Overflow)?;
    let earned = a.earned.checked_add(b.earned).ok_or(MathError::Overflow)?;
    Ok(TimeFee { prepaid, earned, refund: prepaid - earned })
}

pub fn spot_gross(q: u64, price: u64, side: Side) -> Result<u64> {
    let num = mul(q.into(), price.into())?;
    to_u64(if side == Side::Buy { ceil_div(num, UNIT)? } else { num / UNIT })
}
pub fn spot_reserve(q: u64, pmax: u64) -> Result<u64> { to_u64(ceil_div(mul(q.into(), pmax.into())?, UNIT)?) }
pub fn free_capital(a: u64, q: u64, pmax: u64, rp: u64, h: u64, buffer: u64) -> Result<i128> {
    let liabilities = add(add(spot_reserve(q, pmax)?.into(), rp.into())?, add(h.into(), buffer.into())?)?;
    let a = i128::from(a);
    let liabilities = i128::try_from(liabilities).map_err(|_| MathError::Overflow)?;
    a.checked_sub(liabilities).ok_or(MathError::Overflow)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FreeReturn { pub negative: bool, pub numerator: u128, pub denominator: u128 }
pub fn free_return(entry_num: u64, entry_den: u64, exit_num: u64, exit_den: u64) -> Result<FreeReturn> {
    if entry_num == 0 || entry_den == 0 || exit_den == 0 { return Err(MathError::InvalidDenominator) }
    let x = mul(exit_num.into(), entry_den.into())?;
    let y = mul(entry_num.into(), exit_den.into())?;
    Ok(FreeReturn { negative: x < y, numerator: x.abs_diff(y), denominator: mul(exit_den.into(), entry_num.into())? })
}

/// Accounting transition model for the later token program. It never infers Q from
/// wallet balance; Q moves only in an explicit program sale or redemption.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Ledger { pub assets: u64, pub external_q: u64, pub pmax: u64, pub pro_reserve: u64, pub other_reserved: u64, pub buffer: u64 }
impl Ledger {
    pub fn available(&self) -> Result<i128> {
        free_capital(self.assets, self.external_q, self.pmax, self.pro_reserve, self.other_reserved, self.buffer)
    }
    pub fn settle_to_claim(&mut self, max_reserved: u64, payout: u64, prepaid_refund: u64) -> Result<ClaimLedger> {
        if max_reserved > self.pro_reserve || payout > max_reserved || prepaid_refund > self.other_reserved {
            return Err(MathError::InvalidInput)
        }
        let new_other = self.other_reserved.checked_add(payout).ok_or(MathError::Overflow)?;
        self.pro_reserve -= max_reserved;
        self.other_reserved = new_other;
        Ok(ClaimLedger { payout, prepaid_refund, paid: false })
    }
    pub fn pay_claim(&mut self, claim: &mut ClaimLedger) -> Result<()> {
        if claim.paid { return Err(MathError::InvalidInput) }
        let due = claim.payout.checked_add(claim.prepaid_refund).ok_or(MathError::Overflow)?;
        if due > self.assets || due > self.other_reserved { return Err(MathError::InvalidInput) }
        self.assets -= due;
        self.other_reserved -= due;
        claim.paid = true;
        Ok(())
    }
}
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ClaimLedger { pub payout: u64, pub prepaid_refund: u64, pub paid: bool }

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::Value;
    fn n(v: &Value) -> u64 { v.as_str().unwrap().parse().unwrap() }
    #[test]
    fn shared_golden_vectors() {
        let v: Value = serde_json::from_str(include_str!("../../../contracts/fixtures/golden.json")).unwrap();
        for row in v["prices"].as_array().unwrap() {
            let a: Vec<u64> = row["input"].as_array().unwrap().iter().map(n).collect();
            let got = index_price(a[0], a[1], a[2], a[3], a[4]).unwrap();
            assert_eq!(got.price, n(&row["price"]), "{}", row["id"]);
            assert_eq!(got.maximum, n(&row["maximum"]), "{}", row["id"]);
        }
        for row in v["pro"].as_array().unwrap() {
            let a: Vec<u64> = row["input"].as_array().unwrap().iter().map(n).collect();
            let side = if row["direction"] == "long" { Direction::Long } else { Direction::Short };
            let got = pro(a[0], a[1], a[2], a[3], a[4], side).unwrap();
            assert_eq!(got.notional, n(&row["notional"]), "{}", row["id"]);
            assert_eq!(got.payout, n(&row["payout"]), "{}", row["id"]);
            assert_eq!(got.reserve, n(&row["reserve"]), "{}", row["id"]);
        }
        for row in v["curve"].as_array().unwrap() {
            let side = if row["side"] == "buy" { Side::Buy } else { Side::Sell };
            assert_eq!(curve_gross(n(&row["q0"]), n(&row["q1"]), side).unwrap(), n(&row["gross"]), "{}", row["id"]);
        }
    }
    #[test]
    fn shared_price_boundaries() {
        let rows: Value = serde_json::from_str(include_str!("../../../contracts/fixtures/price-boundaries.json")).unwrap();
        for row in rows.as_array().unwrap() {
            let a: Vec<u64> = row["input"].as_array().unwrap().iter().map(n).collect();
            let got = index_price(a[0], a[1], a[2], a[3], a[4]).unwrap();
            assert_eq!(got.price, n(&row["price"]), "{}", row["id"]);
            assert_eq!(got.maximum, n(&row["maximum"]), "{}", row["id"]);
        }
    }
    #[test]
    fn full_width_division_and_output_range() {
        let numerator = U256::from_u64(u64::MAX).mul_u64(u64::MAX).unwrap().mul_u64(u64::MAX).unwrap();
        let denominator = U256::from_u64(u64::MAX).mul_u64(u64::MAX).unwrap();
        let (q, r) = numerator.div_rem(denominator).unwrap();
        assert_eq!(q.as_u64().unwrap(), u64::MAX);
        assert_eq!(r, U256::ZERO);
        assert_eq!(index_price(u64::MAX, 1, 1, 1, 1), Err(MathError::Overflow));
    }
    #[test]
    fn round_trip_split_and_reserve_boundaries() {
        let half = 500 * UNIT as u64; let full = 1000 * UNIT as u64;
        assert_eq!(curve_gross(0, half, Side::Buy).unwrap() + curve_gross(half, full, Side::Buy).unwrap(), curve_gross(0, full, Side::Buy).unwrap());
        for q in [1, 3, 1000, 1_000_001] {
            assert!(curve_gross(0, q, Side::Buy).unwrap() >= curve_gross(q, 0, Side::Sell).unwrap());
        }
        assert_eq!(pro(100_000_000, 50_000, 1_200_000, 0, 4_800_000, Direction::Long).unwrap().reserve, 1_600_000_000);
        assert_eq!(spot_reserve(1, 4_800_000).unwrap(), 5);
        assert_eq!(free_capital(100, 1, 4_800_000, 0, 0, 0).unwrap(), 95);
    }
    #[test]
    fn time_and_signed_floor() {
        let f = time_fee(1_500_000_000, 500_000_000, 604_800, 302_400).unwrap();
        assert_eq!(f.prepaid, f.earned + f.refund);
        let p = pro(1_000_001, 10_000, 3, 2, 5, Direction::Long).unwrap();
        assert_eq!(p.payout, 666_667); // floor of the entire signed expression
        assert_eq!(time_fee(1, 1, 1, 1).unwrap().refund, 0);
    }
    #[test]
    fn q_and_claim_transitions() {
        let mut l = Ledger { assets: 10_000, external_q: 100, pmax: 2_000_000, pro_reserve: 1_600, other_reserved: 30, buffer: 500 };
        let q = l.external_q;
        let mut claim = l.settle_to_claim(1_600, 200, 10).unwrap();
        assert_eq!(l.pro_reserve, 0);
        assert_eq!(l.other_reserved, 230); // 10 refund was already reserved.
        assert_eq!(l.external_q, q);
        let before = l.available().unwrap();
        l.pay_claim(&mut claim).unwrap();
        assert_eq!(l.available().unwrap(), before);
        assert!(l.pay_claim(&mut claim).is_err());
    }
}
