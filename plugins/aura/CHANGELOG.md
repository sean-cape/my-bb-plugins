# Changelog

## 0.2.4

- Give the conversation column and the composer beside it the Kanban board's smoky glass: the theme background at 75% over a blurred wallpaper.
- Widen the conversation column and composer to 50% of the pane, never narrower than BB's 760px.

## 0.2.3

- Fill any element marked `data-aura-surface` with the full wallpaper, so plugin pages (the Kanban board) can share the thread background.

## 0.2.2

- Add theme-aware reading surfaces to New thread controls and recent threads.
- Cache immutable versioned background images privately for one year.
- Reduce animated dither rendering to 15 FPS and one-third resolution.
- Cache WebGL uniform locations instead of resolving them every frame.

## 0.2.1

- Extend chat wallpapers to the bottom of the pane, including beside the composer.
- Keep half/full wallpaper selection in Aura settings; remove the composer toggle.
- Fade half wallpapers out at the midpoint of New thread; keep chats full-height.
- Restore the correct background when BB reuses panels during navigation.
- Keep wide tables readable beyond the message column, with horizontal scrolling.
- Preserve saved images, slots, dimming preference and scope across reloads.
