"""Turn a folder of Slippi replays into a training dataset for one player.

Runs slippi-ai's own dataset pipeline (parse_local.py, then
convert_sqlite_to_parsed.py, then make_local_dataset.py) on just the games
that player is in, and reports progress as `@@{json}` lines for the app.

Usage:
  python engine/prepare_data.py --replays=<folder> --code=ABCD#123 --work=<dataset root>

Each run rebuilds the work folder from scratch.
"""

import argparse
import collections
import json
import os
import re
import shutil
import subprocess
import sys
import time
import zipfile

ENGINE = os.path.dirname(os.path.abspath(__file__))
VENDOR = os.path.join(os.path.dirname(ENGINE), 'vendor', 'slippi-ai')
# See parser_patch/sitecustomize.py: replaces slippi_db's use of `unzip`.
PARSER_PATCH = os.path.join(ENGINE, 'parser_patch')


def report(stage, **fields):
  print('@@' + json.dumps(dict(stage=stage, **fields)), flush=True)


def normalize_code(code: str) -> str:
  # Replays store the hash sign as its full-width Shift-JIS form.
  return code.replace('＃', '#').strip().upper()


def find_player_games(replay_dir: str, code: str) -> tuple[list[str], dict]:
  """Finds the 1v1 games `code` played in, counting why the rest were skipped."""
  import peppi_py

  paths = []
  for root, _, files in os.walk(replay_dir):
    paths.extend(os.path.join(root, f) for f in files if f.lower().endswith('.slp'))

  stats = dict(files=len(paths), unreadable=0, not_1v1=0, others=0, mine=0)
  # The codes seen most often, to spot a typo or a changed code.
  codes_seen = collections.Counter()
  matches = []
  last = 0.0
  for i, path in enumerate(paths, 1):
    try:
      start = peppi_py.read_slippi(path, skip_frames=True).start
    except Exception:
      stats['unreadable'] += 1
      continue
    codes = [normalize_code(p.netplay.code) for p in start.players if p.netplay and p.netplay.code]
    codes_seen.update(codes)
    if start.is_teams or len(start.players) != 2:
      stats['not_1v1'] += 1
    elif code in codes:
      matches.append(path)
    else:
      stats['others'] += 1
    if time.time() - last > 0.25 or i == len(paths):
      last = time.time()
      report('scan', done=i, total=len(paths), found=len(matches))
  stats['mine'] = len(matches)
  stats['top_codes'] = codes_seen.most_common(5)
  return matches, stats


def run_step(stage: str, script: str, args: list[str], total: int = 0):
  """Runs one of slippi-ai's scripts, turning its tqdm output into progress."""
  env = dict(os.environ, PYTHONPATH=os.pathsep.join([PARSER_PATCH, VENDOR]),
             PYTHONIOENCODING='utf-8')
  proc = subprocess.Popen(
      [sys.executable, os.path.join(VENDOR, script), *args],
      stdout=subprocess.PIPE, stderr=subprocess.STDOUT, env=env,
      text=True, encoding='utf-8', errors='replace')
  tail = collections.deque(maxlen=30)
  lines_seen = []
  buf = ''
  while True:
    chunk = proc.stdout.read(256)
    if not chunk:
      break
    buf += chunk
    # tqdm redraws with carriage returns, so split on both.
    *lines, buf = re.split(r'[\r\n]', buf)
    for line in lines:
      if not line.strip():
        continue
      tail.append(line)
      lines_seen.append(line)
      m = re.search(r'Parsing:.*?(\d+)/(\d+)', line)
      if m:
        report(stage, done=int(m.group(1)), total=int(m.group(2)))
  if proc.wait() != 0:
    raise RuntimeError(f'{script} failed:\n' + '\n'.join(tail))
  return lines_seen


def character_summary(work: str, code: str) -> dict[str, int]:
  import melee
  meta = json.load(open(os.path.join(work, 'meta.json'), encoding='utf-8'))
  counts = collections.Counter()
  for row in meta:
    for p in row['players']:
      if normalize_code((p.get('netplay') or {}).get('code') or '') == code:
        counts[melee.Character(p['character']).name.lower()] += 1
  return dict(counts.most_common())


def main():
  parser = argparse.ArgumentParser()
  parser.add_argument('--replays', required=True)
  parser.add_argument('--code', required=True)
  parser.add_argument('--work', required=True)
  args = parser.parse_args()
  code = normalize_code(args.code)

  # Start from scratch every time. Building on a previous run meant a run that
  # failed halfway left its replays marked as done, so every retry found none.
  shutil.rmtree(args.work, ignore_errors=True)
  raw = os.path.join(args.work, 'Raw')
  os.makedirs(raw, exist_ok=True)

  games, stats = find_player_games(args.replays, code)
  if not games:
    report('done', games=0, characters={}, stats=stats)
    return

  archive = os.path.join(raw, 'replays.zip')
  with zipfile.ZipFile(archive, 'w', zipfile.ZIP_STORED) as z:
    for i, path in enumerate(games, 1):
      # Prefix with the index: replay names repeat across month folders.
      z.write(path, f'{i:06d}-{os.path.basename(path)}')
      if i % 50 == 0 or i == len(games):
        report('pack', done=i, total=len(games))

  threads = max(1, (os.cpu_count() or 2) // 2)
  run_step('parse', 'slippi_db/parse_local.py',
           [f'--root={args.work}', f'--threads={threads}', '--noin_memory'])
  run_step('index', 'slippi_db/scripts/convert_sqlite_to_parsed.py',
           [f'--root={args.work}'])
  lines = run_step('index', 'slippi_db/scripts/make_local_dataset.py',
                   [f'--root={args.work}'])

  # slippi-ai's own reasons for leaving games out of training, e.g.
  # 'Filtered 12.00% due to "game length too short"'.
  stats['filtered'] = {}
  for line in lines:
    m = re.search(r'Filtered ([\d.]+)% due to "(.+)"', line)
    if m:
      stats['filtered'][m.group(2)] = round(float(m.group(1)) * len(games) / 100)

  characters = {}
  if os.path.exists(os.path.join(args.work, 'meta.json')):
    characters = character_summary(args.work, code)
  report('done', games=sum(characters.values()), characters=characters, stats=stats)


if __name__ == '__main__':
  main()
