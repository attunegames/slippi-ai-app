"""Keeps Phillip loaded between games so Play starts in seconds.

Starting Phillip from scratch takes 15-20 s: importing TensorFlow/JAX, then
building (and for JAX bots, compiling) the agent. This server does that once,
in the background, while the player is still choosing, and reuses the built
agent for every game. Each game is the same session scripts/eval_two.py runs:
a human against one AI in Slippi Dolphin.

  python engine/play_server.py --mode=jax|tf

--mode=jax keeps TensorFlow out of the process entirely. JAX bots only need it
through optional imports, and it is the slowest library to load.

Commands arrive as JSON lines on a localhost socket (the port is announced
with a "listening" event); events go out as "@@{json}" lines on stdout.
Not stdin: on Windows, a thread blocked reading stdin stalls every process
multiprocessing spawns, and libmelee spawns one to talk to Dolphin.

  {"cmd": "prepare", "model": path, "profile": name, "humanPort": 1|2}
  {"cmd": "play", ...prepare fields, "character": name, "dolphin": dir, "iso": path}
  {"cmd": "stop"}
"""

import argparse
import enum
import json
import logging
import os
import pickle
import queue
import socket
import sys
import threading
import time
import traceback

# Phillip runs on the CPU when playing (as eval_two.py does).
os.environ.setdefault('CUDA_VISIBLE_DEVICES', '')

_send_lock = threading.Lock()


def report(event: str, **fields):
  with _send_lock:
    print('@@' + json.dumps(dict(event=event, **fields)), flush=True)


class _NoTensorFlow:
  """Import hook that makes "import tensorflow" fail fast."""

  def find_spec(self, name, path=None, target=None):
    if name == 'tensorflow' or name.startswith('tensorflow.'):
      raise ImportError('TensorFlow is not loaded for JAX bots.')
    return None


class OpponentType(enum.Enum):
  """Stand-in for slippi_ai.rl.run_lib.OpponentType.

  RL models pickle this enum in their training config. Importing the real
  one pulls in the whole TensorFlow RL stack, and playing never uses it.
  """
  CPU = 'cpu'
  SELF = 'self'
  OTHER = 'other'


class _Unpickler(pickle.Unpickler):

  def find_class(self, module, name):
    if module == 'slippi_ai.rl.run_lib' and name == 'OpponentType':
      return OpponentType
    # Same remap as slippi_ai.saving.CustomUnpickler.
    if module == 'slippi_ai.embed' and name == 'ItemsType':
      module = 'slippi_ai.tf.embed'
    return super().find_class(module, name)


class Server:

  def __init__(self):
    from slippi_ai import eval_lib, dolphin
    self.eval_lib = eval_lib
    self.dolphin_lib = dolphin

    self.states: dict[str, dict] = {}
    self.agent = None
    self.agent_key = None
    self.profile = None
    self.dolphin = None
    self.stop_requested = False
    self.lock = threading.Lock()

  def load_state(self, path: str) -> dict:
    if path not in self.states:
      with open(path, 'rb') as f:
        self.states[path] = _Unpickler(f).load()
    return self.states[path]

  def prepare(self, model: str, profile: str | None, human_port: int):
    """Builds the agent for this bot and port, unless it already exists."""
    bot_port = 2 if human_port == 1 else 1
    key = (model, bot_port)
    state = self.load_state(model)

    if key != self.agent_key:
      report('preparing', model=model)
      started = time.time()
      self.agent = None
      self.agent_key = None
      self.agent = self.eval_lib.build_agent(
          port=bot_port,
          opponent_port=human_port,
          console_delay=2,  # eval_two.py's online_delay
          state=state,
          name=profile or 'Master Player',
          async_inference=True,
      )
      self.agent_key = key
      self.profile = profile
      logging.info('Built agent in %.1fs', time.time() - started)

    if profile and profile != self.profile:
      # The profile is just the name code fed to the network, so switching
      # it doesn't need a rebuild.
      code = self.eval_lib.get_name_code(state, profile)
      self.agent._agent._agent.set_name_code(code)
      self.profile = profile

    report('ready', model=model, profile=self.profile)

  def play(self, cmd: dict):
    """Runs one session; returns when Dolphin closes or stop() is called."""
    self.prepare(cmd['model'], cmd.get('profile'), cmd['humanPort'])
    self.stop_requested = False
    self._session(cmd)

  def _session(self, cmd: dict):
    import melee
    dolphin_lib = self.dolphin_lib
    human_port = cmd['humanPort']
    bot_port = 2 if human_port == 1 else 1
    agent = self.agent
    connected = False
    error = None

    try:
      bot = dolphin_lib.AI(character=melee.Character[cmd['character'].upper()])
      self.eval_lib.update_character(bot, agent.config)
      players = {human_port: dolphin_lib.Human(), bot_port: bot}

      config = dolphin_lib.DolphinConfig(
          path=cmd['dolphin'],
          iso=cmd['iso'],
          # Use the player's own Dolphin settings, including their controllers.
          copy_home_directory=True,
          headless=False,
          infinite_time=False,
          online_delay=2,
          emulation_speed=1,
          instant_match_restart=False,
      )
      report('opening')
      dolphin = dolphin_lib.Dolphin(players=players, **config.to_kwargs())
      with self.lock:
        self.dolphin = dolphin
      if self.stop_requested:
        return
      connected = True
      report('running')

      agent.set_controller(dolphin.controllers[bot_port])
      agent.start()
      try:
        num_games = 0
        slow_warned = False
        for gamestate in dolphin.iter_gamestates(skip_menu_frames=False):
          if dolphin_lib.is_menu_state(gamestate):
            continue
          if gamestate.frame == -123:
            num_games += 1
            report('game', number=num_games)
          started = time.perf_counter()
          agent.step(gamestate)
          if time.perf_counter() - started > 0.016 and not slow_warned and gamestate.frame > 60:
            slow_warned = True
            report('slow')
      finally:
        agent.stop()
    except Exception as e:  # Dolphin closing mid-game also ends up here.
      if not (connected or self.stop_requested):
        error = ''.join(traceback.format_exception_only(e)).strip()
        logging.error(traceback.format_exc())
    finally:
      with self.lock:
        dolphin, self.dolphin = self.dolphin, None
      if dolphin is not None:
        try:
          dolphin.stop()
        except Exception:
          pass
      report('stopped', error=error)

  def stop(self):
    self.stop_requested = True
    with self.lock:
      dolphin = self.dolphin
    if dolphin is not None:
      try:
        dolphin.stop()
      except Exception:
        pass


def read_commands(listener: socket.socket, commands: queue.Queue, server: 'Server'):
  """Feeds commands from the app into the queue; "stop" acts immediately."""
  conn, _ = listener.accept()
  with conn, conn.makefile('r', encoding='utf-8') as lines:
    for line in lines:
      line = line.strip()
      if not line:
        continue
      try:
        cmd = json.loads(line)
      except ValueError:
        continue
      if cmd.get('cmd') == 'stop':
        server.stop()
      else:
        commands.put(cmd)
  commands.put(None)  # the app went away


def main():
  parser = argparse.ArgumentParser()
  parser.add_argument('--mode', choices=['tf', 'jax'], default='tf')
  args = parser.parse_args()
  logging.basicConfig(level=logging.INFO)

  started = time.time()
  if args.mode == 'jax':
    sys.meta_path.insert(0, _NoTensorFlow())
    import jax  # noqa: F401
  else:
    import tensorflow  # noqa: F401
  server = Server()

  listener = socket.create_server(('127.0.0.1', 0))
  commands: queue.Queue = queue.Queue()
  threading.Thread(
      target=read_commands, args=(listener, commands, server), daemon=True).start()
  report('loaded', mode=args.mode, seconds=round(time.time() - started, 1),
         port=listener.getsockname()[1])

  # Games run on this (main) thread, one command at a time.
  while (cmd := commands.get()) is not None:
    try:
      kind = cmd.get('cmd')
      if kind == 'prepare':
        server.prepare(cmd['model'], cmd.get('profile'), cmd.get('humanPort', 1))
      elif kind == 'play':
        server.play(cmd)
    except Exception as e:
      logging.error(traceback.format_exc())
      report('error', message=''.join(traceback.format_exception_only(e)).strip())
  server.stop()


if __name__ == '__main__':
  main()
