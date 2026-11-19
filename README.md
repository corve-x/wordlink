# Wordlink

Wordlink is a browser puzzle where the answer to one clue becomes clue for the next. You start with a word initally, then uncover the next word, with only the first letter being seen. Each neighbouring word pairs form familiar phase or a compound word.

> ex: **BLACK → ICE → CREAM → CHEESE → BALL → PARK**
> <br>
> Reads pair as: Black ice, ice cream, cream cheese, cheese ball, ball park

## Tech Stack

- HTML, CSS, JS
- Python, FastAPI
- SQLite

### Requirements

- fastapi
- uvicorn
- explore the requirements-dev.txt for local api testing

## Where the words come from

The default bank in [data/word_pairs.txt](./data/word_pairs.txt) contains **978 unique ordered pairs** using **329 distinct words**. Together they allow **44,573 six-word chains**. (updated manually)

Unique word pairs chosen at random from the and text file for daily puzzle.

### What gets saved

SQLite locally stores: Daily puzzles, game progress, game history.

- Daily puzzles - Stores the six-word chain for each date so everyone who plays Daily mode that day gets the same puzzle.
- Game progress - Tracks each player’s round using an anonymous player ID. When a player returns using the same browser, Wordlink can restore the board where they left off.
- Game history - Keeps a record of each player’s 10 most recently completed rounds with game mode, completed chain, time taken, hints used.

## Notes

The tests/ folder contains AI-generated tests for checking Wordlink’s gameplay during development. The folder is optional and can be omitted when running or deploying the website.

## Deployment

deployed on vercel: https://wordlink-sigma.vercel.app/
