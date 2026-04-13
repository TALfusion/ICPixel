# NFTs

## Overview

NFTs in ICPixel represent completed missions. They are minted on-chain using the ICRC-7 standard when an alliance's mission reaches 95% completion.

## Who Receives the NFT

Only the **alliance leader** receives the NFT. Other members earn ICP rewards through the mission reward pool.

## Metadata

Each NFT contains:

| Field | Description |
|-------|-------------|
| Name | Mission name (alliance name) |
| Description | Mission description |
| Pixel count | Number of pixels in the mission |
| Season | Which season the NFT was minted in |
| Global index | The NFT's number across all seasons |
| Image | The completed pixel art, rendered as PNG, stored fully on-chain |

## Rarity

There is no artificial rarity system. Rarity is determined by:

- **Season number** — Season 1 NFTs are the rarest (first ever minted)
- **Global index** — NFT #1 is unique forever
- **Pixel count** — Larger missions = harder to complete = rarer
- **The image itself** — Recognizable or creative art holds more value
- **Market dynamics** — The community decides what's valuable

## Mission Upgrades and NFTs

When a leader upgrades a completed mission:

1. The old NFT continues to exist during the new round
2. When the expanded mission reaches 95%:
   - The old NFT is **burned**
   - A new NFT is minted with updated metadata (larger pixel count, new image)
3. If the leader doesn't complete the upgraded mission, they keep the original NFT

## Treasury Distribution

At the end of each season, the remaining treasury is distributed to all NFT holders of that season. The formula weights:

- **Mission size** — Larger missions get a bigger share (sqrt scaling)
- **Mint order** — Earlier NFTs get a slight bonus

This gives NFTs ongoing value beyond collectibility — holding an NFT from a popular season means passive income.

## Trading

NFTs follow the ICRC-7 standard and can be transferred or traded on any compatible marketplace. Royalties on resale go to the project.

## On-Chain Storage

Everything is stored on-chain:
- Metadata in the NFT canister's stable memory
- Images rendered as PNG from the pixel template
- No IPFS, no external hosting — fully self-contained on the Internet Computer
