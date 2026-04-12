{
  description = "zorvix";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };
        lib = pkgs.lib;
      in
      {
        packages.default = pkgs.buildNpmPackage {
          pname = "zorvix";
          version = "1.8.6";

          src = ./.;

          npmDepsHash = "sha256-+QybCCTpl+lKdv5MKkp/H4iPcPS3kIWYfl8Qu5K2AW8=";

          buildPhase = ''
            npm install
            npm run build:src
          '';

          installPhase = ''
            mkdir -p $out/bin
            cp -r dist/* $out/
            chmod +x $out/*.min.mjs
            ln -s $out/zorvix.min.mjs $out/bin/zorvix
          '';
        };

        devShells.default = pkgs.mkShell {
          buildInputs = [
            pkgs.nodejs_22_x
            pkgs.nodePackages.npm
            pkgs.nodePackages.tsx
          ];
        };
      });
}
