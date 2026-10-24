# AUR package (Arch Linux, Omarchy, Manjaro, EndeavourOS)

`sarala-bin` repackages the `.deb` from each GitHub release; nothing is compiled.
Users install it with `yay -S sarala-bin` (or `paru`), and pacman delivers updates:
the in-app updater turns itself off when the package manager owns the binary.

## Publishing a release

1. After the release workflow finishes: `aur/update.sh X.Y.Z`
2. Regenerate the metadata on any Arch machine or container:
   `cd aur/sarala-bin && makepkg --printsrcinfo > .SRCINFO`
   (test with `makepkg -si` first)
3. Copy `PKGBUILD` and `.SRCINFO` into a clone of
   `ssh://aur@aur.archlinux.org/sarala-bin.git`, commit and push.

The first push needs an [AUR account](https://aur.archlinux.org/register) with
your SSH public key added; pushing to the empty repo creates the package.
