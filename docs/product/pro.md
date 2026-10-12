# Pro

Pro is the test-asset long and short flow, separate from no-money chips. A Pro position can gain or lose test assets and needs an executable market, matching Devnet wallet, valid quote, and program admission.

## Opening a position

Select **Pro Long** or **Pro Short** after reviewing direction, collateral, maximum test leverage, quote expiry, and market state. The implementation caps entry leverage at **5×** and reserves potential liability under program rules. A displayed maximum is not a recommendation or promise of safety.

## Closing and settlement

Pro positions have their own close, settlement, and claim steps. A submitted transaction is not a finalized position. Data outages, low activity, market phase, vault capacity, and operator gates can affect new entry or settlement. Existing exits and claims follow their own permissions; an entry pause does not cancel obligations.

The settlement model and automated keeper have runtime dependencies. This public snapshot alone does not establish that every worker is running. Use current action and chain state; do not assume automatic claim or fixed return.

## Read next

- [Markets and trading](/docs/markets-trading)
- [Liquidity](/docs/liquidity)
