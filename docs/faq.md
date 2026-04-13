# FAQ

## General

**What is ICPixel?**
A collaborative pixel battle game on the Internet Computer. Place pixels, form alliances, complete missions, earn ICP.

**Is it free to play?**
You can view the map and watch replays for free. Placing pixels costs $0.05 each in ICP.

**Do I need a crypto wallet?**
You need an Internet Identity (II) anchor. It's free to create and works like a passkey — no seed phrases, no extensions.

**Is everything on-chain?**
Yes. Frontend, backend, game data, NFT images — all hosted on ICP canisters. Nothing on AWS, nothing on IPFS.

## Gameplay

**Can I overwrite someone else's pixel?**
Yes. All pixels are equal. Anyone can overwrite anyone.

**What's the cooldown?**
10 seconds between pixel placements. Same for everyone.

**What happens if someone sabotages my mission?**
There's no protection. Your alliance must defend the mission by re-painting correct pixels. The "repairers" earn mission credits for fixing them.

**Can I be in multiple alliances?**
No. One alliance at a time.

**Can I leave my alliance?**
Yes, but there's a cooldown period. Alliance leaders cannot leave.

## Economy

**How do I earn money?**
Place correct pixels on active missions. When the mission completes, claim your share of the reward pool proportional to your contribution.

**How much can I earn?**
Depends on the season's activity. More players = bigger reward pool = bigger payouts. A single correct pixel in a popular mission can return 5-20x its cost.

**What if nobody plays?**
Reward pool scales with activity. Few players = small pool but also less competition. The economics stay balanced.

**Where does the money come from?**
10% of every pixel purchase and alliance creation goes into the mission reward pool. It's funded by the players themselves.

## NFTs

**Who gets the NFT?**
Only the alliance leader. Other members earn ICP through mission rewards.

**Can I sell my NFT?**
Yes. ICPixel NFTs are standard ICRC-7 tokens. Trade them on any compatible marketplace.

**What makes an NFT valuable?**
Season number (earlier = rarer), pixel count (bigger = harder), mint order (lower = more historic), and the art itself.

**Do NFTs earn passive income?**
Yes. At the end of each season, the treasury is distributed to all NFT holders of that season.

## Technical

**What blockchain is this on?**
The Internet Computer (ICP) by DFINITY.

**What token standard are the NFTs?**
ICRC-7.

**How are payments handled?**
ICRC-2 (approve + transfer_from). You approve a spending amount, then the canister pulls the exact cost per pixel.

**Is the code open source?**
Yes. [GitHub](https://github.com/TALfusion/ICPixel).

**What happens if the canister runs out of cycles?**
The game auto-pauses at critically low cycle levels. An admin tops up cycles and resumes the game.
