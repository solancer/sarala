# Follow the Omarchy theme

On Linux, choose **Themes → Omarchy (System)** to use Omarchy's active
background, foreground and accent colours. The option appears in the gallery
and palette after a valid system palette is detected. The selection is saved
with the other Sarala settings. Choosing another theme stops following Omarchy.

While selected, Sarala checks the active `colors.toml` every two seconds. Theme
changes apply without restarting the app or reloading the document. Light/dark
controls, syntax highlighting and Mermaid diagrams follow the palette. Styled
HTML and PDF exports include a snapshot of the active colours. The editable
Custom base16 scheme is kept separately.

The native reader checks these locations in order:

1. `$XDG_STATE_HOME/omarchy/current/theme/colors.toml`
   (default `~/.local/state/omarchy/current/theme/colors.toml`).
2. `$XDG_CONFIG_HOME/omarchy/current/theme/colors.toml`
   (default `~/.config/omarchy/current/theme/colors.toml`, for older installs).

Only absolute XDG paths are used. A valid palette requires quoted six-digit
hex `background` and `foreground` entries in the root of the file. Named
colours and numbered ANSI `color0`–`color15` entries are supported; missing
optional colours are derived from the background and foreground. `mode` can
explicitly select `light` or `dark`; otherwise the background luminance is used.
This is a scanner for Omarchy's flat palette format, not a general TOML parser.
No theme scripts, hooks, arbitrary file paths or shell commands are executed.

A temporarily missing or incomplete file retains the last complete palette.
If a saved Omarchy selection is opened where the palette is unavailable,
Sarala uses a neutral dark fallback; another theme can still be selected.
The web app and non-Linux desktops do not read host theme files. Sandboxed
Linux packages need host access to a palette location to detect it.

No Omarchy hooks, launcher overrides, preload libraries or additional runtime
dependencies are required for this integration.
