"""Point d'entree pour PyInstaller : un script au niveau racine (hors du
package) pour que les imports relatifs de pole_scoring/__main__.py se
resolvent normalement (PyInstaller traite le script d'analyse comme un
module __main__ independant, donc pole_scoring doit etre importe, pas
execute directement)."""

from pole_scoring.__main__ import main

if __name__ == "__main__":
    main()
