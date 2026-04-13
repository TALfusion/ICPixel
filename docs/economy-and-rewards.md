# Economy & Rewards

## Pricing

| Item | Cost |
|------|------|
| 1 pixel | $0.05 (in ICP) |
| Alliance (1st) | Free |
| Alliance (2nd) | $3 |
| Alliance (3rd) | $5 |
| Alliance (4th) | $7 |
| Alliance (5th+) | $10 |

Prices are in USD, paid in ICP at the current exchange rate (updated every 12 hours via the ICP Exchange Rate Canister).

## Fee Split

Every payment is split three ways:

| Recipient | Share | Purpose |
|-----------|-------|---------|
| Owner | 50% | Project revenue |
| Treasury | 40% | Season-end distribution to NFT holders |
| Reward Pool | 10% | Continuous payouts to mission contributors |

### Example: 1 pixel ($0.05)

- $0.025 to owner
- $0.020 to treasury
- $0.005 to reward pool

## Mission Rewards

### How Credits Work

When you place a pixel that matches a mission template:

1. The pixel is checked against all active missions covering that cell
2. If the color matches the template — you receive a **credit** for that cell
3. **Last correct wins** — if someone overwrites a correct pixel and you fix it, the credit transfers to you
4. Alliance members get **x2 weight**, non-members get **x1 weight**

### Continuous Flow

The reward pool doesn't accumulate for one big payout. Instead:

- Every pixel purchase adds $0.005 to the reward pool
- This is immediately distributed across all **completed** missions, proportional to their pixel count
- Larger missions earn a larger share of the flow

### Claiming Rewards

After a mission completes (95%), contributors can claim their share:

```
your_reward = mission_pool * (your_weight / total_weight)
```

Where:
- `your_weight` = number of credited cells * multiplier (x2 member, x1 non-member)
- `total_weight` = sum of all contributors' weights
- `mission_pool` = accumulated rewards for that mission round

Rewards grow over time as more pixels are purchased across the map. You can claim multiple times — each claim pays out the delta since your last claim.

### Example

Mission 10x10 (100 pixels). You're an alliance member who placed 30 correct pixels.

- Your weight: 30 * 2 = 60
- Total weight (all contributors): 200
- Mission pool accumulated: $80

**Your payout: $80 * 60/200 = $24.00**
**You spent: 30 * $0.05 = $1.50**
**Net profit: $22.50**

## Treasury

The treasury accumulates 40% of all revenue throughout the season. At the end of the season, the entire treasury balance is distributed to **NFT holders** of that season.

Larger and earlier NFTs receive a bigger share. This makes NFTs valuable beyond just collectibility — they're a claim on future revenue.

## Anti-Bot Economics

The system is designed so that random/bot play is unprofitable:

- Each pixel costs $0.05 regardless
- Only correct pixels (matching a mission template) earn rewards
- Random placement has ~0% chance of matching any mission
- Botting requires knowing the template + placing correct colors = same effort as real play
- Economic barrier: even smart bots must spend $0.05 per pixel
