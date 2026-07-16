# Asset licensing and project status

The MIT license in `LICENSE` covers this repository's source code,
documentation, geometric placeholder pet (`public/placeholder.svg`), and
project-created application icons, unless a file states otherwise.

## Local classic-penguin material

Files under `.local-assets/`, generated files under `public/local/`, and any
archive marked `local-classic` are deliberately excluded from Git. A local
developer may supply a classic red-scarf penguin reference for private
experimentation, but this project does not grant a license to copy, publish,
sell, or redistribute that reference or a derivative of it.

The public build pipeline always substitutes the rights-safe geometric
placeholder. A local-classic portable build requires the explicit
`-IncludeLocalClassicAssets` switch, is rejected in CI, and receives a
`LOCAL-ONLY-NOT-FOR-REDISTRIBUTION.txt` notice.

QQ and related penguin characters, names, logos, and trademarks may be owned
by Tencent or other rights holders. They are not licensed by this repository.

## OpenAI and Codex

OpenAI and Codex names and marks belong to their respective owner. This is an
independent compatibility project; it is not produced, sponsored, endorsed,
or reviewed by OpenAI. No OpenAI pet artwork is distributed in this
repository.

If you contribute an asset, you must have the right to license it for this
project and must document its source and license in this file.
