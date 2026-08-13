# Asset licensing and project status

The MIT license in `LICENSE` covers this repository's source code,
documentation, original Aurora Penguin assets (`public/aurora-penguin.png`
and `public/aurora-penguin-wave.png`), and project-created application icons,
unless a file states otherwise.

## Original public mascot

Aurora Penguin is an original project mascot: an indigo-and-ivory penguin
with an asymmetric teal explorer collar and gold star pin. The two source PNGs
were generated for this project with OpenAI image generation on 2026-08-13,
then selected, background-cleaned, palette-normalized, animated, and quality
checked in this repository. They are released under the repository's MIT
license. They are not official OpenAI or Codex artwork and do not use an
OpenAI logo or trademark as part of the character.

## Local classic-penguin material

Files under `.local-assets/`, generated files under `public/local/`, and any
archive marked `local-classic` are deliberately excluded from Git. A local
developer may supply a classic red-scarf penguin reference for private
experimentation, but this project does not grant a license to copy, publish,
sell, or redistribute that reference or a derivative of it.

The public desktop build pipeline always selects the redistributable original
Aurora Penguin. Local classic material may appear during an explicit local
development run, but the Tauri installer builder and CI force the public
mascot and never package local classic assets.

QQ and related penguin characters, names, logos, and trademarks may be owned
by Tencent or other rights holders. They are not licensed by this repository.

## OpenAI and Codex

OpenAI and Codex names and marks belong to their respective owner. This is an
independent compatibility project; it is not produced, sponsored, endorsed,
or reviewed by OpenAI. No official OpenAI or Codex pet artwork is distributed
in this repository.

If you contribute an asset, you must have the right to license it for this
project and must document its source and license in this file.
