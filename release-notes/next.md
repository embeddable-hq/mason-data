The next release's notes, gathered here until its `v<version>.md` is written: a `v*.md` file is itself the release.

## Before you upgrade

- No table is read again.

## What changes

- **Every list on the web page now behaves the same in a narrow window.** Where a list is wider than the window, it
  scrolls sideways inside its box, and each row's buttons stay in view at its right. The page itself never scrolls
  sideways.

## What was wrong and is now right

- **Some lists on the web page read badly in a narrow window. They now read whole.**
  - On the Users page, the Role column was cut to "every t…" in a middle-width window. It now shows the role whole.
    A user's id is cut short where the name's column is narrow. Hover over it to read it whole.
  - On the Users page, on a phone 320 to 390 px wide, a user's "from …" line could sit under the Queries, Disable and
    Remove buttons, so a tap on it pressed one of them. It now sits beside them, and a long one is cut short. Hover
    over it to read it whole.
  - On the Tables page, on a phone 320 to 350 px wide, the Table column was squeezed to a few letters a line. The list
    now scrolls sideways there instead. A row count too long for its column, such as "~40,000,000 rows", is cut short.
    Hover over it to read it whole.
  - On the Sync events page, a table name of 30 characters was cut short in a middle-width window. A name of up to 30
    characters is now shown whole.
  - On a phone, after Add or Sync now, the answer shown at the bottom of the screen covered the last rows' buttons, and
    the page could not be scrolled far enough to reach them. It now can.
