# Markets and trading

Explore brings observed Devnet markets and read-only reference subjects into one catalog. Check each item's source, observation date, and available actions.

## Reading a market

The collected Devnet `solana` and `tariff` keywords use observed X Counts data and graduated indexed markets. Their chip records and market data come from the Devnet services. The registered `wow` keyword is still preparing data. **Preview** subjects show public reference data or official metadata and artwork. All previews are read-only, with no chips, trades, token quotes, or participation history.

Preview snapshots name the platform metric, such as YouTube views, X post likes, or Spotify track streams. The linked source, UTC capture time, and any provider report date identify the count. Spotify counts reported by a third party retain that attribution and report date. A single count appears as a snapshot; histories and changes need additional observations.

The **Chips**, **Buy / Sell**, **Pro**, and **Liquidity** tabs remain visible for preview subjects. You can explore each action, but inputs and submission stay disabled with **Not open yet** until the required market is connected. Adding a chart or another observation does not by itself enable trading.

Data can be preparing, current, low activity, or unavailable. New paid entry may be blocked during a gap or recovery while an existing exit remains allowed. The action area explains unavailability. An API failure appears as unavailable data.

## Buy and sell

**Buy** and **Sell** exchange test assets on an executable market. Before graduation, the program uses a bonding curve. After graduation, spot exchange uses the index path. These are financial trades, unlike chips. Quotes expire and may change with data or market state. Review amounts, fees, market, and wallet instructions before signing.

Registration and graduation are separate operations subject to program and operator rules. A catalog item alone is not a registered market. The MVP uses a custom Anchor program and a reserve based settlement design; it does not borrow or reconstruct external AMM liquidity.

## Read next

- [Pro](/docs/pro)
- [Liquidity](/docs/liquidity)
- [Data and pricing](/docs/data-pricing)
