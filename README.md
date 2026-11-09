# The 3am Room

A website that's only open from 3:00 to 3:15am, UK time. The rest of the day it shows a countdown. If you make it in, you can read the notes people left last night and leave one line for whoever turns up tomorrow.

The page is plain HTML, CSS and JavaScript hosted on GitHub Pages. The notes live in a free Supabase database, and the opening hours are checked on Supabase's clock, not the visitor's, so changing your computer's time doesn't get you in early.

## Setting it up

You'll need a free Supabase account. It takes about ten minutes.

1. Create a new project at [supabase.com](https://supabase.com). Any name and region is fine (London is closest).
2. In the project, open the SQL Editor, paste in everything from `supabase/schema.sql`, and press Run. It should say "Success. No rows returned".
3. Copy two things into `config.js`: the project URL (it's on the project's home page, and under Project Settings, then Data API) and the publishable key (Project Settings, then API Keys; older projects call it the `anon` key). This key is meant to be public. Don't ever use the `secret` or `service_role` key here.
4. Commit and push `config.js`.
5. On GitHub, open the repo's Settings, then Pages. Under "Build and deployment" choose "Deploy from a branch", pick `main` and `/ (root)`, and save. After a minute or so the site will be at `https://<your-username>.github.io/<repo-name>/`.

## Trying it out without waiting until 3am

Add `?preview` to the end of the address to see the open room with some made-up notes. Nothing you write in preview is saved.

To test the real thing at another time of day, change `'03:00'` in the `door_open_time` function in `schema.sql` to a time a minute or two from now, and run just that function in the SQL editor. Put it back to `'03:00'` afterwards. Anything posted during your test will show up as "last night" at the next real opening, so you might want to clear it out with `delete from messages;`.

## How it decides whether you're in

`door_status()` in the database works out whether it's currently between 3:00 and 3:15 in London (it handles the clocks changing) and when the next opening is. The page asks for this when it loads, uses it to correct for your computer's clock being off, and then counts down by itself. When the countdown hits zero it asks again.

The database rules only allow reading notes while the room is open, and only notes from the last day. Writing is only allowed while it's open too. Each note is at most 140 characters, the same note can't be posted twice in a night, and there's a cap of 300 notes a night. The page also limits each browser to one note a night, but that's an honour system: someone determined could get round it.

## Files

- `index.html` is the page itself.
- `style.css` holds the two looks: a flat overcast day while closed, a lamp-lit room while open.
- `app.js` does the countdown, loads the notes, and posts new ones.
- `config.js` is where your Supabase details go.
- `supabase/schema.sql` sets up the database, the opening hours and the rules.

## Changing things

The opening time and length are in `door_open_time()` and `door_length()` at the top of `schema.sql`. The wording on the page is all in `index.html`. Colours and fonts are the variables at the top of `style.css`.
