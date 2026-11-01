# MuVid plugin

Sends videos from Stash to the MuVid service (`/media/matt/WD/tmp/muvid`), which
cuts them to music on the beat. The calls go through the downloader
(`downloader/muvid_service.py`, under `/muvid/`), since Stash's CSP only lets
plugins talk to it. Use the **MuVid** navbar item, or **♪ Music video** on a tag page:

- **Videos:** all of the library, or the scenes with some tags (any or all of
  them, with their sub-tags if you want), leaving out scenes with other tags
  (MuVid's own exports are always left out). The page shows how many match.
- **Music:** a scene in Stash (a music video, say) or a file on the disk.
- **+ Add videos** on a project sends more videos (by the same choice) to its bin.

The studio opens in MuVid's own web app, in a tab of its own. Stash's CSP doesn't
let video from other ports play, so it isn't embedded. Exports go to the
library's `MuVid` folder and come back (through MuVid's export callback) as
scenes tagged **MuVid**, with the performers of the scenes the export actually uses.

Settings: `muvid_url` (where the browser opens MuVid; default the same host,
port 10144). The downloader reads `MUVID_URL` and `MUVID_TOKEN` from
`~/.config/muvid/env`.
