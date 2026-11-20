# Wordlink

Wordlink is a browser puzzle where the answer to one clue becomes clue for the next. You start with a word initally, then uncover the next word, with only the first letter being seen. Each neighbouring word pairs form familiar phase or a compound word.

## Updated race feature (1v1 online)

- The 1v1 race now uses the same letter tiles as solo play, no login required.
- Three hints per player, per race. Reveal a letter after 10 seconds on the current word, or reveal the whole word after 20 seconds. Either option costs one hint. Using hint only affects your board.
- Live updates of words solved by either player on both sides.
- When either of the players solve the whole sequence, the game stops and ends. Start again on either sides simultaneously starts the next round.
- Redis free db is being used for the 1v1 duels.

## Tech Stack

- HTML, CSS, JS
- Python, FastAPI
- SQLite, Redis

### Requirements

- fastapi
- uvicorn
- explore the requirements-dev.txt for local api testing

## Where the words come from

The default bank in [data/word_pairs.txt](./data/word_pairs.txt) contains **978 unique ordered pairs** using **329 distinct words**. Together they allow **44,573 six-word chains**. (updated manually)

Unique word pairs are randomly selected from the text file.

### What gets saved

#### - SQLite locally stores: Daily puzzles, game progress, game history (only for solo and daily puzzles)

- Daily puzzles - Stores the six-word chain for each date so everyone who plays Daily mode that day gets the same puzzle.
- Game progress - Tracks each player’s round using an anonymous player ID. When a player returns using the same browser, Wordlink can restore the board where they left off.
- Game history - Keeps a record of each player’s 10 most recently completed rounds with game mode, completed chain, time taken, hints used.

#### - Redis is used for online 1v1 race mode (real-time multiplayer coordination)

- Keeps both player in sync in a private room.
- If both players click Play again, the backend uses a Redis transaction to record both votes and start exactly one new round.
- Each room expires after 90 seconds, so abandoned rooms clear themselves automatically.

## Deployment

deployed on vercel: https://wordlink-sigma.vercel.app/
