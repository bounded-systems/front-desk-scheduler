{
  description =
    "front-desk-scheduler — Front Desk (org project #2) modeled as a concurrent scheduler; DST sim (Node) + TLA+ model checking (TLC).";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, flake-utils }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs { inherit system; };

        # Node >= 23.6 for native TypeScript type-stripping (the src/ runs as .ts).
        node = pkgs.nodejs_24;

        # nixpkgs `tlaplus` provides the CLI wrappers: tlc, pcal, sany, tla2tex.
        tla = pkgs.tlaplus;

        runTlc = name: cfg:
          pkgs.writeShellApplication {
            inherit name;
            runtimeInputs = [ tla ];
            text = ''
              cd "''${1:-.}"
              exec tlc specs/tla/scheduler.tla -config specs/tla/${cfg}
            '';
          };

        tlcRacy = runTlc "tlc-racy" "scheduler-racy.cfg";
        tlcAtomic = runTlc "tlc-atomic" "scheduler-atomic.cfg";

        test = pkgs.writeShellApplication {
          name = "fds-test";
          runtimeInputs = [ node ];
          text = ''exec node --test "''${1:-.}/test/"'';
        };
      in {
        devShells.default = pkgs.mkShell {
          packages = [ node tla ];
          shellHook = ''
            echo "front-desk-scheduler devshell"
            echo "  node $(node --version)   $(tlc -h 2>&1 | head -n1 || echo 'TLC ready')"
            echo "  node --test test/        # DST sim (5 invariant tests)"
            echo "  node scripts/demo.ts     # print the reproduced race traces"
            echo "  tlc specs/tla/scheduler.tla -config specs/tla/scheduler-racy.cfg"
            echo "  tlc specs/tla/scheduler.tla -config specs/tla/scheduler-atomic.cfg"
          '';
        };

        apps = {
          test = {
            type = "app";
            program = "${test}/bin/fds-test";
          };
          tlc-racy = {
            type = "app";
            program = "${tlcRacy}/bin/tlc-racy";
          };
          tlc-atomic = {
            type = "app";
            program = "${tlcAtomic}/bin/tlc-atomic";
          };
        };

        # `nix flake check` sanity: the toolchain builds.
        packages.toolchain = pkgs.buildEnv {
          name = "fds-toolchain";
          paths = [ node tla ];
        };
      });
}
