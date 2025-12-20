"""Astronomical Log Book CLI.

Usage:
    alog manifest <manifest>
    alog cli <command> [<args>...]"""
import typer

import cli
import manifest

app = typer.Typer(no_args_is_help=True)

app.add_typer(manifest.app, name="manifest")
app.add_typer(cli.app, name="cli")

if __name__ == '__main__':
    app()