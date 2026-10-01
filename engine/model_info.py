"""Describe a Phillip model file as JSON: who it can play as, and its settings.

Usage: python engine/model_info.py <model path>

Writes `<model path>.json` next to the model too, so the app can read it later
without starting Python again.
"""

import json
import sys

from slippi_ai import saving


def describe(path: str) -> dict:
  state = saving.load_state_from_disk(path)
  config = state['config']
  name_map: dict[str, int] = state.get('name_map') or {}

  # Several spellings can share one slot (e.g. "Cody", "iBDW", "IBDW#734");
  # the first one listed is the main name.
  profiles: dict[int, str] = {}
  for name, code in name_map.items():
    if name and code not in profiles:
      profiles[code] = name

  rl_names = []
  rl_config = state.get('rl_config') or {}
  agent_names = (rl_config.get('agent') or {}).get('name') or []
  if isinstance(agent_names, str):
    agent_names = [agent_names]
  for name in agent_names:
    if name not in rl_names:
      rl_names.append(name)

  characters = config['dataset'].get('allowed_characters') or 'all'
  return dict(
      platform=config.get('platform', 'tf'),
      delay=config['policy']['delay'],
      characters=characters.split(',') if characters != 'all' else 'all',
      # Profiles the self-play stage trained; the others come from imitation only.
      trained_profiles=rl_names,
      profiles=[profiles[c] for c in sorted(profiles)],
  )


if __name__ == '__main__':
  path = sys.argv[1]
  info = describe(path)
  with open(path + '.json', 'w', encoding='utf-8') as f:
    json.dump(info, f, indent=1)
  print('@@' + json.dumps(info), flush=True)
