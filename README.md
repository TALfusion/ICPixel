# ICPixel WAR

Collaborative pixel battle — fully on-chain on the [Internet Computer](https://internetcomputer.org/).

## What is it

A shared canvas where players place pixels, form alliances, and compete to complete pixel-art missions. Think r/place meets crypto.

- Place pixels on a growing map (1×1 → 2048×2048)
- Create alliances and set image missions at specific coordinates
- Complete missions to earn unique NFTs
- Season-based: map grows as players fill it, ends after reaching max size

## Tech stack

- **Backend**: Rust canister on ICP (Internet Computer Protocol)
- **Frontend**: React + TypeScript, hosted as an IC asset canister
- **NFTs**: ICRC-7 standard, fully on-chain (metadata + images)
- **Payments**: ICP via ICRC-2
- **Pricing**: IC Exchange Rate Canister (on-chain oracle)

100% on-chain. No external servers, no databases, no cloud.

## Getting started

Requires [dfx](https://internetcomputer.org/docs/current/developer-docs/getting-started/install/), Rust, Node.js 18+.

```bash
dfx start --background
./scripts/deploy.sh
```

Open the printed URL.

## License

All rights reserved.
