"""Fine-tune a released Phillip model on one player's replays.

This is a thin wrapper around slippi-ai's TensorFlow imitation trainer
(slippi_ai/tf/train_lib.py). It adds the two things that trainer needs to
start from a *released* model instead of one of its own checkpoints:

1. Released models only keep the policy weights (no optimizer, value
   function or step counter), so restoring only fills in what is there.
2. The player gets a nametag slot of their own: the least-used slot in the
   model's name map is handed over to their connect code, so the finished
   bot plays "as" that player.

Usage:
  python engine/train_my_bot.py --base=models/doc_d18_imitation_v3 \
    --data=<dataset root with Parsed/ and meta.json> --code=ABCD#123 \
    --out=bots/my-bot --minutes=60
"""

import json
import logging
import multiprocessing
import os
import pickle
import sys

from absl import app, flags

flags.DEFINE_string('base', None, 'Released model to start from.', required=True)
flags.DEFINE_string('data', None, 'Dataset root (Parsed/ + meta.json).', required=True)
flags.DEFINE_string('code', None, 'Connect code of the player to imitate.', required=True)
flags.DEFINE_string('out', None, 'Folder to write the new bot to.', required=True)
flags.DEFINE_string('characters', None, 'Comma-separated characters; default = the base model\'s.')
flags.DEFINE_float('minutes', 60, 'How long to train.')
flags.DEFINE_integer('batch_size', 64, 'Training batch size.')
flags.DEFINE_float('learning_rate', 3e-5, 'Fine-tuning learning rate.')
flags.DEFINE_integer('workers', 2, 'Data loading worker processes.')

FLAGS = flags.FLAGS


def give_player_a_slot(name_map: dict[str, int], code: str) -> dict[str, int]:
  """Hands the least-used nametag slot to `code`.

  Slots are numbered by how common the name was in the original training
  data, so the highest code belongs to the rarest player.
  """
  name_map = dict(name_map)
  if code in name_map:
    return name_map
  slot = max(name_map.values())
  for name in [n for n, c in name_map.items() if c == slot]:
    del name_map[name]
  name_map[code] = slot
  return name_map


def allow_partial_restore(tf):
  """Lets the trainer's restore skip parts a released model doesn't have."""
  original = tf.nest.map_structure

  def map_structure(fn, *structures, **kwargs):
    if (len(structures) == 2 and all(isinstance(s, dict) for s in structures)
        and set(structures[1]) < set(structures[0])):
      target, source = structures
      logging.info('Restoring only %s from the base model.', sorted(source))
      return {k: original(fn, target[k], source[k], **kwargs) for k in source}
    return original(fn, *structures, **kwargs)

  tf.nest.map_structure = map_structure


def use_spawn_on_windows():
  """slippi-ai's data workers ask for "forkserver", which Windows lacks."""
  if sys.platform != 'win32':
    return
  original = multiprocessing.get_context

  def get_context(method=None):
    return original('spawn' if method == 'forkserver' else method)

  multiprocessing.get_context = get_context


def main(_):
  import tensorflow as tf
  import wandb
  from slippi_ai import flag_utils, saving
  from slippi_ai.tf import saving as tf_saving
  from slippi_ai.tf import train_lib

  base = saving.load_state_from_disk(FLAGS.base)
  config_dict = tf_saving.upgrade_config(base['config'])
  name_map = give_player_a_slot(base['name_map'], FLAGS.code)

  os.makedirs(FLAGS.out, exist_ok=True)
  start_path = os.path.join(FLAGS.out, 'start.pkl')
  with open(start_path, 'wb') as f:
    pickle.dump(dict(
        state=dict(policy=base['state']['policy']),
        config=config_dict,
        name_map=name_map,
    ), f)

  config = flag_utils.dataclass_from_dict(train_lib.Config, config_dict)
  config.restore_pickle = start_path
  config.expt_dir = FLAGS.out
  config.tag = os.path.basename(os.path.normpath(FLAGS.out))

  config.dataset.data_dir = os.path.join(FLAGS.data, 'Parsed')
  config.dataset.meta_path = os.path.join(FLAGS.data, 'meta.json')
  config.dataset.allowed_names = FLAGS.code
  config.dataset.banned_names = 'none'
  if FLAGS.characters:
    config.dataset.allowed_characters = FLAGS.characters

  config.data.batch_size = FLAGS.batch_size
  config.data.num_workers = FLAGS.workers
  config.learner.learning_rate = FLAGS.learning_rate

  config.runtime.max_runtime = int(FLAGS.minutes * 60)
  config.runtime.save_interval = 300
  config.runtime.log_interval = 30
  # The trainer only saves after an evaluation that beats the last one, and
  # by default evaluates once per pass over the data, which on a CPU can take
  # longer than the whole run. Evaluate at the start (so there is a playable
  # bot right away) and a few times per pass, on part of the test games.
  config.runtime.eval_at_start = True
  config.runtime.num_evals_per_epoch = 4
  config.runtime.num_eval_epochs = 0.5

  # bot.json belongs to the app; this records what the run itself used.
  with open(os.path.join(FLAGS.out, 'training.json'), 'w') as f:
    json.dump(dict(base=os.path.basename(FLAGS.base), code=FLAGS.code,
                   characters=config.dataset.allowed_characters), f, indent=2)

  allow_partial_restore(tf)
  use_spawn_on_windows()
  wandb.init(mode='disabled')
  train_lib.train(config)


if __name__ == '__main__':
  # https://github.com/python/cpython/issues/87115
  __spec__ = None
  app.run(main)
