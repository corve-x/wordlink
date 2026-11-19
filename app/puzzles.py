"""Loads the editable pair bank and builds validated six-word chains."""
import os
import random
import warnings
from collections import defaultdict
from functools import lru_cache
from pathlib import Path

DEFAULT_BANK = Path(__file__).resolve().parent.parent / "data" / "word_pairs.txt"
CHAIN_LEN = 6
MIN_WORD, MAX_WORD = 3, 9


def bank_path():
    return Path(os.environ.get("WORDLINK_PAIRS", DEFAULT_BANK))


@lru_cache(maxsize=1)
def pairs():
    """Set of (first, second) tuples, upper-case. Bad lines are skipped with a warning."""
    found = set()
    for n, line in enumerate(bank_path().read_text("utf-8").splitlines(), 1):
        line = line.split("#")[0].strip()
        if not line:
            continue
        parts = line.upper().split()
        ok = (
            len(parts) == 2
            and parts[0] != parts[1]
            and all(p.isascii() and p.isalpha() and MIN_WORD <= len(p) <= MAX_WORD for p in parts)
        )
        if ok:
            found.add((parts[0], parts[1]))
        else:
            warnings.warn(f"word_pairs.txt line {n} ignored: {line!r}")
    return frozenset(found)


@lru_cache(maxsize=1)
def graph():
    g = defaultdict(list)
    for a, b in sorted(pairs()):
        g[a].append(b)
    return dict(g)


def reload():
    pairs.cache_clear()
    graph.cache_clear()


def is_valid_chain(words):
    """Six distinct words, five valid links."""
    words = list(words)
    if len(words) != CHAIN_LEN or len(set(words)) != CHAIN_LEN:
        return False
    p = pairs()
    return all((a, b) in p for a, b in zip(words, words[1:]))


def make_chain(rng: random.Random, avoid=None):
    """Random (but seed-deterministic) validated chain; never equal to `avoid`."""
    g = graph()
    starts = sorted(g)
    rng.shuffle(starts)

    def walk(path):
        if len(path) == CHAIN_LEN:
            return path
        options = list(g.get(path[-1], ()))
        rng.shuffle(options)
        for w in options:
            if w not in path:
                found = walk(path + [w])
                if found:
                    return found
        return None

    for start in starts:
        chain = walk([start])
        if chain and chain != avoid and is_valid_chain(chain):
            return chain
    raise RuntimeError("Pair bank cannot produce a six-word chain; add more pairs.")


def count_chains():
    g = graph()

    def count(path):
        if len(path) == CHAIN_LEN:
            return 1
        return sum(count(path + [w]) for w in g.get(path[-1], ()) if w not in path)

    return sum(count([s]) for s in g)


if __name__ == "__main__":
    print(f"{len(pairs())} valid pairs, {len(graph())} words with a follower")
    print(f"{count_chains()} possible six-word chains")
    print("Example:", " -> ".join(make_chain(random.Random())))