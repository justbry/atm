# Autumn monorepo. The atm package has its own recipes: `just atm test`, `just atm check`, `just atm release-dry`.

mod atm 'packages/atm'

# List the recipes
default:
    @just --list --list-submodules
