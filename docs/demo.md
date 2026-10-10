# Demo script: Perun in 5 minutes

For showing Perun to runners, walkers and cyclists who are tired of handing their routes to a
fitness cloud. One Android phone, one laptop with Basecamp. The phone records; the laptop is
where you dig into the numbers. No account, no server in the middle.

## Before (20 minutes, once)

**Phone:** add the F-Droid repo from [apps.vpavlin.xyz](https://apps.vpavlin.xyz) and install
**Perun**. Recommended: install **Loam** too, open it once and leave it running. Perun then syncs
through Loam's one shared node and asks you to approve it there the first time. Loam is optional:
without it, Perun runs its own node (the *Shared Logos Delivery node* switch is on the pairing
screen).

**Laptop:** Basecamp 0.3. Add the package repository `https://apps.vpavlin.xyz/logos-repo.json`
and install **Perun Analytics** (Perun Core and Loam Core come along). Open it and wait until the
status line under the title says **Connected · paired**.

**Pair them.** Laptop: **Pair phone** (bottom right) shows a QR code. Phone: tap **Pair** (top
right) → **Scan QR code**. Check the three words on the phone match the words in the laptop
dialog, then **Done** on the phone and **Close** on the laptop. The phone header now says
**Paired** with a green dot.

**Record two or three short runs beforehand.** A live outdoor run doesn't fit in five minutes,
and there is no sample-data import on the phone. Pick *Run* (or *Walk*), tap **Record run**, walk
around the block for 10 minutes, **Hold to stop**. Add a note or a photo along the way if you
like. Sync one of them now (**Sync to Basecamp** on the run) and keep one unsynced for the live
moment.

Optional, laptop only: **Publish sample run** adds a made-up 20-minute "Morning run" so the
trends page has more than one week to show.

## The demo

**1. The phone (1 min).** Open Perun.
- The run list, grouped by week with weekly totals at the top of each group.
- Show the start screen: the sport chips (*Run, Trail, Walk, Hike, Ride, MTB*) and the GPS line
  (*GPS ready · ±5 m*). Optional: tap **Record run**, show the 3-2-1 countdown and the big
  distance number, then **Hold to stop** (indoors it will say *Nothing to save*, that's fine).
- *Say:* the run lives on your phone. Nobody else has a copy unless you send it.

**2. One run (phone, 1 min).** Tap the run you kept unsynced.
- Distance, time, average pace, climb; the map, the elevation profile, per-km splits.
- Tap **Hide map for sharing (privacy)**: "Share the shape and the numbers, not where you live."
- If you pinned a note or photo, show it under *Annotations*.

**3. The aha: send it to the laptop (1 min).** Tap **Sync to Basecamp**.
- The button shows progress (*Route: sent…*, *Annotations: … sent…*).
- On the laptop the run appears in the list on the left within seconds. Click it.
- *Say:* no cloud, no account, no upload to a company. The phone talked straight to your
  laptop over the Logos network, encrypted with the key you just scanned. Only your devices can
  read it.

**4. The analytics (laptop, 1 min).** On the run you just synced:
- The tiles, the route on the map, **ELEVATION**, and the splits table (*KM · PACE · ELEV · HR*).
  Heart rate only shows for tracks that have it; the phone has no HR sensor.
- **▶ Replay**: drag along the route and watch the distance and elevation at each point.
- **+ Note** → type "Felt strong on the hill" → **Add**. It shows up under the run on the phone
  too (marked *shared*).

**5. The big picture (laptop, 1 min).** Click **📊 Trends & totals**.
- Total runs, distance, time and climb; **WEEKLY DISTANCE** for the last 12 weeks;
  **PERSONAL BESTS** (longest run, biggest climb, fastest pace).
- *Say:* this is the part a fitness cloud usually charges for, and here it's computed on your
  own laptop from your own data.

## If something goes wrong

- **The run doesn't appear on the laptop:** both devices must be online at the moment you tap
  **Sync to Basecamp**; there is no server holding it for later. Check the laptop says
  **Connected · paired**, then tap **Sync to Basecamp** again (resending is safe).
- **The laptop status stays on "Starting node…"** or its small diagnostics line shows
  *peers 0*: give it a minute to find the network; restarting Basecamp usually helps.
- **The phone says "Pair to sync":** it isn't paired. Do the pairing step again.
- **Loam installed but nothing moves:** open Loam and make sure Perun is approved there.
- **Backup plan:** **Export GPX** on the phone and on the laptop works with no network at all.

## What to leave them with

- Record on the phone, analyse on the desktop, no account and no cloud. Your runs stay yours.
- Encrypted between your own devices; the map can be hidden before you share an image.
- [apps.vpavlin.xyz](https://apps.vpavlin.xyz) to install (F-Droid for the phone, the Basecamp
  repository for the desktop).
