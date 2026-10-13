# Sonic Universe

A music-driven 3D world. Milestone 1 ships **World A: Cosmic Genesis** — a GPU-simulated spiral galaxy (9k–66k stars) whose gravity, shockwaves, light and camera are driven by real-time analysis of the song you play.

```bash
npm install
npm run dev          # http://localhost:5173
npm test             # audio-analysis test suite (Node, no browser needed)
npm run build        # production build → dist/
npm run build:single # one self-contained HTML file → dist-single/
```

Play a file (picker or drag-and-drop), the built-in demo groove, or the microphone. Keys: `Space` play/pause · `F` fullscreen · `C` cinematic camera · `Z` freeze · `P` performance · `O` settings · `H` hide UI · `W A S D Q E` fly (Shift = fast) · `Shift+←/→` seek 5 s. Hover attracts/repels stars (touch: press and hold); Shift strengthens the field.

## Architecture

Five layers, each only talking to the next through a narrow interface:

| Layer | Files | Owns |
|---|---|---|
| 1. Audio acquisition & analysis | `src/audio/AudioEngine.ts`, `FeatureExtractor.ts`, `BeatTracker.ts`, `dsp.ts` | AudioContext, sources, one `AnalyserNode`; pure-TS feature extraction |
| 2. Feature mapping | `src/mapping/drives.ts` | Features → world-agnostic **drives** (`gravity`, `pulse`, `shimmer`, `sparkle`, `flow`, `energy`, `calm`, `tension`, `release`, event counters) |
| 3. Simulation state | `src/worlds/cosmic/CosmicSim.ts` + compute shaders | GPU ping-pong position/velocity textures; CPU owns shells, satellite wells, ripple phase |
| 4. Rendering | `src/worlds/cosmic/CosmicGenesis.tsx`, `shaders.ts`, `src/engine/PostFX.tsx` | Stars, gas disk, sky, glows, bloom/tone mapping |
| 5. User controls | `src/ui/Overlay.tsx`, `src/store/useStore.ts`, `src/engine/CameraRig.tsx`, `PointerTracker.tsx` | Zustand store, camera, pointer, panels |

Per-frame data (features, drives, pointer, perf) lives in mutable singletons in `src/engine/frameBus.ts`, never in React state, so 60 Hz data causes no re-renders. `AnalysisDriver` runs first each frame (negative `useFrame` priority), then camera, then the world, then post-processing.

**Adding a world:** write a component that reads `drives()` and renders, then register it in `src/worlds/registry.ts`. Audio, mapping, camera, pointer, post-processing, UI and adaptive quality are shared; switching worlds never touches playback.

## Audio analysis (layer 1)

All features come from a 2048-point `AnalyserNode` (Blackman window, `smoothingTimeConstant = 0`) read once per frame. The extractor is plain TypeScript and is tested in Node against an exact emulation of the analyser (`src/audio/fft.ts`).

- **Band energies** — mean power per bin in dB: bass 30–140 Hz, low-mid 140–500, mid 500–2.5 k, high 2.5–16 k.
- **Adaptive normalisation** — per band, in dB: a ceiling that jumps up instantly and decays 0.35 dB/s, a floor that drops instantly and rises 0.6 dB/s, primed from the first real measurement and adapting 8× faster for the first 4 s. Quiet and loud masters land on the same 0..1 scale while a 20 s breakdown still reads as quiet. Tested: the same song 20 dB quieter gives bass within 0.12 and kicks at ≥ 90 % recall.
- **Smoothing** — attack/release envelopes per feature (e.g. bass 25 ms / 220 ms), all time-constant based so behaviour is frame-rate independent.
- **Loudness** — RMS of the waveform in dBFS; silence below −58 dBFS for 0.4 s freezes the normalisers.
- **Spectral centroid** — power-weighted, mapped to a log-frequency 0..1 (60 Hz–16 kHz).
- **Spectral flux** — half-wave-rectified log-magnitude difference, broadband and per band; z-scored against an exponentially weighted mean/variance (outliers clamped so peaks don't raise the threshold).
- **Onsets** — broadband (z > 2, 90 ms refractory) and hi-hat (5–16 kHz, z > 2.2, 70 ms).
- **Low-end hits / kicks** — a 35–150 Hz flux onset *or* a ≥ 4.5 dB level rise over ~50 ms opens a 55 ms window; it is confirmed if the low band peaks within 6 dB of the song's low-end ceiling and dominates the mids by > 6 dB. Impulse strength scales with both, so the kick drum (loudest low end) drives the biggest shockwaves and bass notes smaller ones. Only "strong" hits steer the beat grid and structure detection.
- **Tempo & beat phase** — every pair of recent onsets votes for periods d/k (k = 1..8) into a Gaussian-smoothed 70–180 BPM histogram, weighted by recency and 1/√k, times a log-normal prior at 120 BPM; parabolic peak interpolation; 3-estimate hysteresis on tempo changes. A phase-locked loop nudges the grid toward kicks within ±20 % of a predicted beat. During breakdowns the tempo is held (flywheel).
- **Structure** — *breakdown*: kicks absent > 1.8 s and energy or bass below the song's running norm (exits only when the kick returns); *build*: rising brightness/onset density inside a breakdown; *drop*: first strong kick after a breakdown held ≥ 2 s (armed once per breakdown), or a sharp energy jump.

## Song map (look-ahead for files)

When a file loads it plays immediately on live analysis while a Web Worker analyses the whole song (`src/audio/songMap.ts`): decoded at 22.05 kHz and downmixed (half the memory, same frequency resolution with a 1024-point FFT), then run through the same `FeatureExtractor` so hits mean the same thing, and post-processed with knowledge of the future:

- **Tempo** from pairwise inter-onset votes over every strong hit in the song.
- **Beat grid** where each beat is pulled toward the strength-weighted circular-mean phase of kicks within ±4 beats on *both* sides, compensated for the analysis window's ~15 ms detection latency. Correct from the first beat, flywheels through kick-free passages, and is a stateless lookup, so seeking never loses it.
- **Breakdowns** as whole spans: no strong kick within ±1 s and the 1 s-smoothed low end more than 6 dB under the song's median; gaps under 1 s merged, spans under 2 s dropped.
- **Drops** at the first strong kick within 3 s after a breakdown, if the low end and the kick pattern really return; snapped to the beat. Songs without breakdowns get energy-jump drops (not within the first 8 s).
- **Build-ups**: an eased 0→1 ramp over up to 8 s before each drop. The galaxy winds up (faster spin, stronger density wave, tighter gravity), the cinematic camera rises toward a top-down view and pushes in, and the drop releases it.
- **Level percentiles** prime the adaptive normalisers, so there is no warm-up.

When the map lands, beats and structure switch to it; bands, hits and hi-hats stay live. The microphone always uses live analysis. Files over 80 MB or 25 minutes stay live-only. The transport shows progress, then the tempo and number of drops, with drops and breakdowns marked on the seek bar.

On "My Love" (6:10): map built in 3.8 s in Node and 13 s in a software-rendered browser; beat agreement with the reference 0.99 (live tracker 0.87); beats correct in the first 10 s 100 % (live 21 %); drops at 3:12.2, 4:48.2 and 5:20.2 on the reference section boundaries, each with a 4.3–4.5 s build-up.

## Sound families (which instruments are playing)

`src/audio/soundFamilies.ts` splits every frame into six kinds of sound. It does not recognise instruments (no trained model knows "violin" here); it separates sound by how it behaves, which is also what tells instruments apart to the ear:

1. **Harmonic / percussive separation** by median filtering (Fitzgerald, DAFx 2010) on a 64-band log spectrum (30 Hz – 11 kHz). Sustained tones are smooth along time, so a 0.28 s time-median keeps them; transients are smooth along frequency, so a median across ±0.8 octave keeps them. Masks use a 3 dB separation margin (Driedger, Müller & Disch, ISMIR 2014); what is neither (reverb, breath, noise textures) joins no family. Below ~300 Hz a 46 ms window cannot resolve tones across frequency (a bass note smears over many bands), so there the split is by time alone: only the part of a band more than 3 dB above its time-median is a hit.
2. **Sustained vs moving**: the harmonic part is split again against a ~1.7 s median. What the long median still holds is *sustained* (pads, strings, drones, held chords); what rises 4 dB above it is *moving* (melody, vocals, arps, riffs). The margin keeps beating partials and chorused pads sustained.
3. **Families** = a component in a range: **kick** (percussive 30–150 Hz), **hits** (percussive 150–4000 Hz: snares, claps, congas, and the attacks of plucked or struck notes), **hats** (percussive 5–11 kHz), **bass** (harmonic 30–250 Hz), **pads** (sustained 250–5000 Hz), **lead** (moving 250–5000 Hz). Also: the melody's register (log-frequency centroid of the moving part) and a harmony colour (chroma of the sustained part, 400 Hz – 4 kHz, mapped onto the circle of fifths so related chords get related colours).
4. **Levels**: the larger of the family's loudness within the song's own range (the chorus is bigger than the verse) and its share of what is sounding right now (a quiet intro drone still reads as pads), gated so a family more than 24–38 dB below the mix stays dark. Onsets per family use one shared detector; kick onsets come from the confirmed low-hit detector, which rejects bass-note attacks.

For files, the song map computes all of this with **centred** medians (it looks ~0.15 s and ~0.85 s ahead), so the visuals know a held chord is held from its first frame. Live (microphone / system audio) it is causal: a new chord reads as "moving" for about half a second before settling into "sustained", and the kick family comes from the low-hit detector because a causal median cannot tell a new bass note's first frames from a kick.

**Verified** (`test/soundFamilies.test.ts`, 19 tests) on a layered ground-truth arrangement where each source enters at a known time (held chord → bass → kick → hats → legato melody → snare): every family lights when its source enters and not before, in both the song-map and the live path; the held chord stays pads, not lead; the melody sits above the bass register; C → F major moves the harmony colour the right way round the circle of fifths; hats and melody notes are counted at their real rates; every snare is caught as a hit. On the demo track, kick and bass vanish in the breakdown and return on the drop while pads and lead open up. On real music (Hans Zimmer, *F1* and *Anything You Wish You'd Done Differently?*; Justin Timberlake, *My Love*) the families follow the spectrograms: F1's hi-hats appear only in the 0:32–2:08 percussion section; *Anything…*'s opening drone reads as pads alone; My Love's claps and vocals register as hits and lead. A whole song is analysed in 3–9 s in Node.

**Limits, honestly:** a boomy 808's tail is tonal and counts partly as bass; a piano or pluck's attack counts as hits and its body as lead or pads; a vocal and a synth lead in the same register are one family; a broadband test for hits (flatness, percentile floors) was tried and dropped because real claps are band-limited and share frames with everything else, so it rejected real claps as often as note attacks.

The **legend** (bottom right, toggle with **I**) shows all six families live in every world, in the colours World C uses.

## World C: Geometric Intelligence

Every sound family builds its own part of one architecture, in its legend colour (`src/worlds/geometric/`): **kick** pulses the red core and sends a wire shell outward on every kick; **hits** throw orange shards from the core; **hats** light points of a gold geodesic lattice; **bass** raises a violet skyline, a radial record of the bass line with one column per sixteenth note when the tempo is known (64 columns = the last four bars); **pads** construct three teal shells edge by edge while sustained sound holds, dissolve them when it stops, and turn them on each chord change (the harmony tints the teal); **lead** draws a pink ribbon around the structure at the melody's pitch, leaving a marker on each new note. Drops answer with everything at once. This is art direction, not physics. The simulation state is pure TypeScript (`geoState.ts`, 4 tests: each family drives its own part and only that part).

Checked offline in a software-rendered browser on F1 at 0:22 (hits and bass only, no hats yet), 1:04 and 1:44 (all six), 2:30 (bass, pads and lead in the coda, no hats), and on *Anything…* at 0:12 (the drone: pads alone, shells constructing) and 1:14.

## Simulation (layers 3–4): what is physics and what is art

**Physical (Newtonian, softened):**
- Central mass and two satellite wells: `a = −GM·r / (r² + ε²)^{3/2}` (Plummer softening).
- An m = 2 logarithmic-spiral density-wave potential rotating at a fixed pattern speed. Stars orbit through it and bunch up in its troughs, which is why the arms persist instead of winding up (Lin–Shu density-wave picture). Force is the numerical gradient of the potential.
- Initial conditions: exponential disk on two log-spiral arms plus inter-arm population and bulge, each star on its circular velocity with small dispersion.

**Artistic (deliberately not physics):**
- *Orbit relaxation* — each star relaxes toward its local circular velocity so the disk re-forms after a disturbance (real galaxies take ~10⁸ years).
- *Kick shockwaves* — an expanding shell applying a radial **pressure pulse** `v = K·S(x)`, `S(x) = 2.33·x·e^{−x²}`, `x = (r − R)/w`, integrated exactly per step as `Δv = K·(S(x₁) − S(x₀))`. S is odd, so net momentum *and* net displacement are zero: stars ripple and return. (An earlier push-only and then push-and-return design made the disk ratchet outward under orbit relaxation; this was found by measurement — see Verification.)
- *Bass gravitational waves* — a travelling quadrupolar vertical ripple through the disk.
- *Gravity breathing* — G rises up to 32 % with bass, tightens during build-ups ("inhale"), drops on the drop ("exhale").
- Satellites surge in on drops and sustained high energy (tidal streams); breakdowns slow simulated time by up to 50 %.
- Cursor attractor/repeller; respawning stars that escape or fall into the core.
- Rendering only: twinkle, hi-hat sparkles (each hi-hat re-rolls which ~6 % of stars flare), heat glow, arm emphasis, bloom following energy.

Integration is semi-explicit Euler with 2 sub-steps on long frames; float32 render targets where `EXT_color_buffer_float` exists, half-float otherwise.

## World E: The Impossible Tunnel

One procedural tube (64–192 segments around, 8 rows per beat), positioned entirely in the vertex shader. The camera's position along it is measured in **beats**: ring k sits at beat k, so you cross a ring exactly when a beat lands.

- **Clock** (`tunnelState.ts`): with a song map, position = map beat index + beat phase, a lookup that survives seeks. Live, it advances at the tracked tempo and phase-locks to the beat tracker. With nothing playing it drifts slowly, and the drift is rounded to whole beats when music starts. Tested: ring crossings land within one frame (16.7 ms) of every song-map beat on the demo; live crossings average under 50 ms from the beat once locked.
- **The tunnel ahead previews the song** (song map only): each ring looks up the music at its own beat's time. Breakdowns open into wide chambers, build-ups squeeze the walls, drops are thick accent gates, and each drop switches the shape beyond it (hexagon → circle → square → octagon → triangle → pentagon). Tested: the chamber, squeeze and gate all appear ahead before the camera reaches them. Live input shows the current state, and drops restyle the tunnel from a few beats ahead.
- **Music:** bass makes the walls glow and breathe; mids twist the geometry; highs send light streaks rushing past and make the data lights twinkle; kicks flash the ring you're crossing; every fourth ring (a bar) is thicker and accent-coloured; build-ups widen the field of view and drops punch it.
- **No swimming:** rows sit on a grid anchored to whole beats, so passing a beat shifts the grid by exactly one beat of rows. The path's tangent at the camera is removed, so you are always centred and curves show ahead.
- **Camera:** this world owns it. Arrow keys / WASD steer within the tunnel, the pointer looks around, and cinematic mode sways gently.

**Sounds own the walls.** Around the tube each sound family holds a band of wall, from the floor counter-clockwise: bass (floor), kick, pads, melody (ceiling), hats, hits. A band's width grows faster than its loudness, so a loud sound crowds the quiet ones out, and it pushes into the tunnel by its loudness, each with its own shape: the bass a smooth rising floor, pads broad walls (tinted by the harmony), hits jagged teeth, hats a twinkling studded strip, the kick a solid red slab, and the melody a bright line along the ceiling that follows its pitch. Levels come per row, one row per 32nd note, through a float texture; with a song map each row reads the song at its own time, so a snare is a ridge that reaches you exactly as it sounds and the walls ahead show what is about to play. Live, rows record what was playing as you pass them and the tunnel ahead shows the current mix. Checked on F1 at 0:22 (violet bass floor and orange hits, little else), 1:04 and 1:44 (all six bands, teal pad walls widest) and 2:30 (the bass floor takes over, no hats).

## World F: Sound Valley

Built after the tunnel proved tiring to watch (tight space, zoom pumping, full-screen colour), then reworked so it moves with the groove rather than scrolling past it.

- **The ground is the music.** Every 16th note is one ridgeline whose profile is the song's spectrum at that moment (32 bands, 40 Hz – 10 kHz, from a 30 fps spectrogram stored in the song map), mirrored either side of the route: bass beside it, highs far out, coloured violet → teal → gold across the valley. A groove draws its own repeating pattern across the land.
- **A visible present.** With a song map, the music's present is a now line a few beats ahead of the camera (from the camera itself the present would be underfoot and out of view). Ridges flare, hit monoliths flash and the melody orb moves exactly as each sound plays; beyond the line lies what is about to play, behind it what just did, dimmed. Live, the now line sits near the horizon and the land is built there and flows toward you.
- **Each family:** kicks roll a real wave across the ground from the now line; hits raise light monoliths on their onsets; hats make the air glint; pads hang aurora curtains, taller when louder and tinted by the chord; the melody is an orb riding the now line at its pitch, leaving its contour behind as a path.
- **Exploration:** the route winds (stable, anchored to beats) and the camera follows it, looking toward the now line, rising gently with the song's energy.

**Sections become landscapes.** The song map also finds the song's sections (beat-synchronous spectrum + sound-family features, Foote novelty on the cosine self-similarity matrix, boundaries snapped to bars, breakdowns and drops always boundaries) and labels sections that are the same kind of passage, with a threshold relative to how different the song's sections are (a steady groove still has exact repeats among its phrases). Each label gets a landscape by energy rank: the loudest becomes sharp ice **mountains**, the quietest (and every breakdown) a flat **lake** where kick ripples run strong, the rest broad **dunes** and **spires**, a city of towers each a frequency band's level over an 8th note. **Land activates when the music reaches it:** ahead of the now line (mid-screen) it is a low, dim preview; crossing the line it rises to full height and lights in its landscape's colour, and just behind the line it keeps breathing with the spectrum you are hearing. Landform noise is keyed to the label, so when a chorus returns, its mountains return. A gate of light, coloured by the landscape ahead, stands where each section begins and flares as it starts; the seek bar shows the sections as a coloured strip. Found on F1: lake, dunes, spires, mountains, dunes, the same mountains again, the same dunes again, lake; My Love's chorus recognised at 2:24 and 3:42; LARK's phrases alternate between three kinds that each return.

**Sync.** With a song map, everything on screen is looked up at the time you *hear*: playback time minus the output latency the browser reports, plus a user "Audio delay" setting for TVs and Bluetooth speakers (persisted). Kicks come from the map's confirmed hits at their exact, latency-corrected times (test: ≥ 90 % within one frame of the true kick); hit monoliths stand at each hit's exact beat position; the now line glows with the spectrum at the exact moment (30 fps), not the 16th-note rows. Live input cannot be delayed this way and runs ahead by the output latency (typically 10–40 ms).

Comfort rules: slow travel (2.4 units per beat), fixed field of view, no camera roll, ridges near the route kept below eye level, light on darkness, no full-screen flashes. Checked on a 125 BPM Afrobeats track (LARK x Nahibeatz x Yonta) and F1.

## World G: Ink in Water

A real 2D fluid: stable fluids on the GPU (Stam 1999, in the WebGL formulation popularised by Pavel Dobryakov): semi-Lagrangian advection, vorticity confinement, a Jacobi pressure solve and gradient subtraction on half-float textures (96–224 cells on the short side, dye at 512–1440). Each sound family injects its own colour of dye with its own kind of force, and the fluid does the blending: kicks push red bursts out from the centre, the bass turns a slow violet whirlpool, pads breathe teal clouds in from the sides, the melody draws a pink stream from an emitter that rises and falls with the tune, hits dart orange, hats fleck gold; new sections and drops stir the tank into one vortex, and breakdowns clear the water faster. Drag to stir. Timescales are split: phrases move the emitters, beats only add impulses, and continuous emitters follow spring-smoothed levels. Physics: the incompressible Euler equations, discretised. Art: what is injected, where, and the colours.

**Smoothing everywhere:** a critically damped spring (`Spring` in `dsp.ts`) eases the valley's breathing spectrum, camera height and sky glow; the valley's ridges interpolate between 16th-note rows and neighbouring bands, use the mean over each 16th rather than its peak, and the ground mesh is finer.

## World B: Liquid Dimension

A convincing GPU approximation, not fluid dynamics (as the brief allows). Two layers:

**Blob physics** (`src/worlds/liquid/liquidSim.ts`, CPU, 10–22 blobs): surface tension between every pair as a spring toward a partly merged separation, 0.75·(rᵢ+rⱼ). It is split by reduced mass, so forces are equal and opposite and momentum is conserved (tested). It is strong at contact and 15 % at range, so scattered drops drift back. Linear drag, a soft spherical container and a weak centring pull complete it. Each blob belongs to a band, which gives the liquid regions: heavy bass masses, mid-size bodies and small high-frequency droplets.

**Surface** (`liquidShaders.ts`): one full-screen raymarch, early-outed by the liquid's bounding sphere. The field is a polynomial smooth-min union of the blobs. It is displaced by band ripples weighted by which kind of blob is nearest: bass regions undulate slowly and widely, mid regions ripple, droplets shimmer. On top of that, kick impact waves travel outward across the surface. Shading reflects a procedural studio (neutral room, white soft boxes, a palette-coloured strip and accent, a coloured floor bounce), with thin-film interference in drifting patches and at grazing angles for the oil-slick iridescence. The bloom threshold is raised for this world so only highlights glow. Quality sets the blob count and march steps (10/48 to 22/100).

**Music:** bass swells only the bass masses (tested); mids swirl the liquid and ripple its middle; highs agitate and shimmer the droplets; kicks fire an outward impulse (light droplets fly furthest) and a surface wave; drops cut surface tension by 85 % and blast the liquid apart, then it re-fuses (tested); breakdowns triple the drag into a slow mirror drift (the same kick moves it < 40 % as much, tested); build-ups strengthen tension and centring and squeeze it together (tested).

On the demo track, connected bodies follow the arrangement: 1 in the intro, 3–7 during the groove as kicks fracture it, back to 1 compact mass in the breakdown (spread 9.9 → 5.2), and a burst into several at the drop.

## World D: Particle Life

Six species of particles (4k–33k by quality) follow the Particle Life law (Mohr / Ventrella "Clusters"): universal repulsion inside β·rMax, then a triangular force of height K[i][j] ∈ [-1, 1] out to rMax, summed over neighbours. The matrix is asymmetric, so species can chase and flee each other; cells, membranes, composite organisms and swimmers emerge with no scripted motion. `src/worlds/life/lifeRules.ts` is the CPU reference of the law; the shaders implement the same law.

**Neighbour search on the GPU** (`lifeShaders.ts`): each step writes (cell, index) keys, sorts them with a bitonic sort (log₂N·(log₂N+1)/2 fragment passes, e.g. 91 at 8k), binary-searches each cell's range, and has every particle visit its 27 surrounding cells. Cells are sized to 1.25 × rMax. Texture sizes are powers of two (64×64 to 256×128). rMax scales as (8192/N)^⅓ so every quality keeps about the same number of neighbours per particle, and therefore the same dynamics and tuning.

**The one approximation:** a particle reads at most CAP neighbours per cell (32/32/24/16 by quality), spread evenly with a per-frame random offset and weighted by count/CAP. It is exact when a cell holds ≤ CAP particles and an unbiased estimate otherwise.

**How the music drives it** (it changes the *rules*, never positions):
- The song picks the ecosystem: after 8 s of audio, a fingerprint of tempo (4-BPM bins), spectral centroid (third-octave bins) and bass/treble balance (3 dB bins) seeds the species matrix, so the same song always grows the same organisms. Brighter timbre morphs up to 35 % toward a companion matrix.
- Bass strengthens every attraction (up to +50 %).
- Kicks briefly scramble the matrix (a random perturbation decaying over 0.35 s) and boost contact repulsion, so bodies scatter and re-form.
- Highs agitate the small, bright spark species.
- Mids add flocking alignment within each species.
- Breakdowns shorten momentum and slow time (structures freeze); build-ups widen the interaction radius up to 1.25×; each drop grows a new ecosystem from the song's seed (crossfaded over 1.5 s).

**Verified** (`?debug`, `__sonic.selfTest()`, at 4k, 8k (128×64) and 16k): sorted keys are a permutation in cell order, every key matches its particle's cell, every cell range is right, and GPU accelerations match the brute-force CPU law to ~1e-7 wherever cells aren't sampled. Averaged over 32 random sample offsets, the error in sampled regions shrinks by 5.4–6.2×, matching √32 = 5.7 as an unbiased estimator must. CPU-reference tests: self-attraction gathers species into their own bodies, pure repulsion forms none, and random ecosystems depart from uniform noise.

## Performance

Stars are one draw call (`THREE.Points` reading the position texture). Quality tiers: 9k / 21k / 37k / 66k stars (default 21k on phones, 37k on desktop). Adaptive quality scales render resolution between 0.5× and the device limit to hold ~45–57 fps; the star count only changes when you choose it (changing it restarts the simulation). Everything is disposed on unmount.

## Verification

- `npm test` — 72 tests (19 for sound families, 4 for World C, 4 for sections and sync). On a synthetic track with ground truth (groove → breakdown with riser → drop): kick recall ≥ 90 % with ≤ 10 % false positives, tempo within 2 BPM at 120 and 100 BPM, beat phase locked, breakdown/build/drop flagged at the right times, hi-hats counted, consistent behaviour 20 dB quieter. Song map: tempo, a beat on every kick from the first one, the grid holding through the breakdown, the drop known in advance on its heard onset, the build-up ramping *before* the drop, no beats or drops fired across a seek, and correct phase on syncopated drums from bar one. On the built-in demo track: synthesis < 4 s, kick recall > 90 %, 122 BPM, one drop at the drop, kicks stronger than bass-note hits. Analysis holds from 60 down to 20 fps (kick recall ≥ 0.96, tempo within 2 BPM).
- `?debug` exposes `window.__sonic.runOffline(samples, sampleRate, seconds)`: analyses audio at exactly 60 fps and steps the real GPU simulation, reading state back from the GPU. Measured on 20,736 stars with a software GPU:

| Input | Mean radius (min–max) | RMS vertical speed | Mean heat | Low-end hits/s |
|---|---|---|---|---|
| Demo, groove | 11.9 (10.7–12.7) | 0.42 | 1.51 | 4.1 |
| Demo, breakdown | 11.5 (10.9–11.8) | 0.13 | 0.01 | 0 |
| Demo, drop | 12.8 (11.4–14.4) | 0.40 | 1.45 | 3.9 |
| Contrast song (96 BPM half-time, heavy sub) | 15.1 (13.7–16.8) | 0.42 | 0.72 | 1.1 |
| Silence (control) | 12.0 (11.5–12.5) | 0.06 | 0 | 0 |

Silence leaves the galaxy still; the breakdown visibly calms it; the drop swells it; a different song builds a different galaxy. No NaNs, no console errors.

**Real-song calibration** (`scripts/analyse-file.ts` runs the extractor over any decoded file at a fixed frame rate). On Justin Timberlake – "My Love" (Timbaland production, syncopated drums, 6:10), checked against a non-causal librosa reference:

| Check | Before | After |
|---|---|---|
| Tempo within 2 BPM of reference (120.2) | 98 % | 98 % |
| Beats agreeing with reference (F, ±70 ms) | 0.16 (locked half a beat off) | 0.87 |
| Hit strength spread (10th–90th percentile) | all 1.00 | 0.19–0.77 |
| Drops | 3:12, 4:48, 5:20 | unchanged; all three sit on reference section boundaries where the beat returns |

Fixes: beat phase now comes from a strength-weighted circular mean of kick times (the old grid was seeded from the last onset and the PLL couldn't correct a half-beat error); hit size is ranked against the song's own recent hits so dense mixes don't saturate. `test/syncopation.test.ts` reproduces the off-beat seed and fails without the fix.

**Limits of that testing:** the container has no GPU, so live rendering was checked at ~5 fps under SwiftShader. Frame rate, bloom cost and feel on real hardware (especially phones) have not been measured here, and the analysis has been calibrated on one real song so far; more genres (Afro house, ambient, rock) will refine the thresholds.

## Next

Sound families could also shape the other worlds (e.g. pads tinting the galaxy's arms, lead steering the liquid). Worth adding with real songs in hand: a calibration pass of the hit-strength and structure thresholds, and WebGPU only if profiling shows the GPGPU pass is the bottleneck.
