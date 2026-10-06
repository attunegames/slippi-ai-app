# Slippi AI

Play Melee against Phillip, the AI from [vladfi1/slippi-ai](https://github.com/vladfi1/slippi-ai), and train a Phillip that plays like you, without touching Python or a terminal.

- **Player clones.** Pick the character Phillip plays and the character you play. The launcher downloads the model tuned for that matchup and lists the players it can imitate (Cody, Hax, Zain, Aklo and others).
- **Rank bots.** Bots that play like a whole rank, from Bronze to Super GM.
- **Train a bot.** Point the launcher at your Slippi replay folder and enter your connect code. It starts from a Phillip that already plays your character like a human, then trains it on your games. The result shows up under **My bots**.

## Download

Windows 10/11, 64-bit. Get the zip from the [latest release](../../releases/latest), unzip it anywhere you can write to (not `C:\Program Files`), and run **Slippi AI.exe**.

You also need the [Slippi Launcher](https://slippi.gg) installed, with your own Melee 1.02 (NTSC) ISO set in it. Slippi AI contains no game data.

## Using it

1. Open **Slippi AI.exe**. The first time, it opens on **Setup**: it finds Slippi Dolphin and your ISO from the Slippi Launcher. Press **Install** once to set up Phillip's engine (Python, TensorFlow and JAX, about 2.5 GB).
2. Go to **Play** and pick a bot. Colors run from easiest to hardest: 🟢 Easy, 🟡 Medium, 🟠 Hard, 🔴 Expert, 🟣 Top. The bot loads in the background; when it says **Phillip is ready**, press **Play**.
3. Dolphin opens with your own controller settings. Pick your character and the stage; Phillip picks its own. Close Dolphin to end the session.

Player clones are strongest for the characters and matchups vladfi trained them for. If your character has no tuned bot, the Rank bots (Master, Grandmaster, Super GM) are the hardest opponents.

Training runs on the CPU. Leave the PC on while it trains. **Stop** keeps the best version saved so far.

## Where things live

Everything the launcher downloads or makes is in `%LOCALAPPDATA%\SlippiAI`:

| Folder | What |
|---|---|
| `runtime`, `python` | The engine (Python and its libraries). |
| `models` | Downloaded Phillip models, each with a `.json` describing it. |
| `datasets` | Your replays, processed for training (one folder per connect code). |
| `bots` | Bots you trained (`latest.pkl` is the bot). |

## How it works

The launcher is an Electron window over slippi-ai's own scripts:

- **Play** goes through `engine/play_server.py`, which runs the same session as slippi-ai's `scripts/eval_two.py` (you as a human player against one AI). It stays running so Phillip is loaded and the bot is built before you press Play, and it keeps TensorFlow out entirely for JAX bots.
- **Read my replays** runs `engine/prepare_data.py`. It picks out your 1v1 games, then runs slippi-ai's `parse_local.py`, `convert_sqlite_to_parsed.py` and `make_local_dataset.py`.
- **Train** runs `engine/train_my_bot.py`, a thin wrapper around slippi-ai's TensorFlow imitation trainer. It:
  - starts from a released `<character>_d18_imitation` model;
  - restores only the policy weights, since that is all a released model keeps;
  - gives your connect code the model's least-used player slot;
  - uses the `spawn` start method on Windows, which has no `forkserver`.

The models are vladfi1's, downloaded on demand from his public [Google Drive folder](https://drive.google.com/drive/folders/1etYN_IgVoUPleAsh76s_9443e4XzGKWo). The app reads that folder's listing at startup, so bots he adds or moves show up without an update. This launcher does not redistribute them.

## Development

```bash
git clone --recurse-submodules https://github.com/attunegames/slippi-ai-app
npm install
npm start               # run from source
npm run catalog         # rebuild catalog/models.json (the offline model list) from vladfi's Drive folder
npm run package         # build dist/Slippi AI-win32-x64
```

`npm run package` downloads `uv.exe` into `vendor/uv` first (`tools/fetch-uv.mjs`); run `node tools/fetch-uv.mjs` yourself to get it for a source checkout.

A source checkout uses its own engine in `runtime/` once it holds `runtime/phillip-engine.ok`. Build it with:

```bash
vendor/uv/uv.exe venv --python 3.12 runtime
vendor/uv/uv.exe pip install --python runtime/Scripts/python.exe -r engine/requirements.lock
```

slippi-ai is pinned in `vendor/slippi-ai` (commit `275c072`), and the engine's libraries are pinned in `engine/requirements.lock`. slippi-ai uses nightly TensorFlow builds, so update both together and test before release.

## Credits

- [slippi-ai](https://github.com/vladfi1/slippi-ai) by vladfi1 (MIT): Phillip itself, its training code and its models.
- [libmelee](https://github.com/altf4/libmelee) by altf4, [Slippi](https://slippi.gg) by Fizzi and team.
- [uv](https://github.com/astral-sh/uv) by Astral (MIT/Apache-2.0) installs the engine.

Launcher by ZeroShot. MIT license.
