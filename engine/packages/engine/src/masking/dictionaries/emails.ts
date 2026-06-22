// Pseudonym dictionary — realistic-but-fake email addresses.
//
// COMPILED-IN, not read at runtime: a `bun build --compile` binary does NOT
// embed assets read via readFileSync (see the transforms.ts header + learning
// bun-compile-readfilesync-not-embedded), so a wordlist on disk would ENOENT in
// the shipped engine. Shipping the list as a static TS export embeds it in the
// binary. Kept modest — every entry adds to binary size.
//
// All domains are RFC 2606 reserved (example.com/org/net), so a pseudonym can
// never collide with a real, routable address. `pseudonymize` picks one
// deterministically by HMAC(salt, value) mod length, so the same input always
// maps to the same fake (join-safe) and a different project salt yields an
// uncorrelated mapping.
export const PSEUDONYM_EMAILS: readonly string[] = [
  "ada.lovelace@example.com",
  "grace.hopper@example.com",
  "alan.turing@example.org",
  "katherine.johnson@example.net",
  "linus.pauling@example.com",
  "rosalind.franklin@example.org",
  "claude.shannon@example.net",
  "barbara.liskov@example.com",
  "edsger.dijkstra@example.org",
  "marie.curie@example.net",
  "john.mccarthy@example.com",
  "dorothy.vaughan@example.org",
  "tim.berners@example.net",
  "radia.perlman@example.com",
  "donald.knuth@example.org",
  "hedy.lamarr@example.net",
  "vint.cerf@example.com",
  "margaret.hamilton@example.org",
  "ken.thompson@example.net",
  "joan.clarke@example.com",
  "dennis.ritchie@example.org",
  "shafi.goldwasser@example.net",
  "leslie.lamport@example.com",
  "frances.allen@example.org",
  "richard.hamming@example.net",
  "annie.easley@example.com",
  "bjarne.stroustrup@example.org",
  "carol.shaw@example.net",
  "guido.rossum@example.com",
  "evelyn.boyd@example.org",
  "james.gosling@example.net",
  "sophie.wilson@example.com",
  "brian.kernighan@example.org",
  "lynn.conway@example.net",
  "niklaus.wirth@example.com",
  "jean.sammet@example.org",
  "robert.tarjan@example.net",
  "mary.jackson@example.com",
  "tony.hoare@example.org",
  "erna.hoover@example.net",
  "peter.naur@example.com",
  "adele.goldberg@example.org",
  "doug.engelbart@example.net",
  "wendy.hall@example.com",
  "butler.lampson@example.org",
  "kathleen.booth@example.net",
  "fernando.corbato@example.com",
  "ruzena.bajcsy@example.org",
  "ivan.sutherland@example.net",
  "irene.greif@example.com",
  "charles.bachman@example.org",
  "elaine.weyuker@example.net",
  "michael.stonebraker@example.com",
  "eva.tardos@example.org",
  "jack.dongarra@example.net",
  "deborah.estrin@example.com",
  "raj.reddy@example.org",
  "nancy.leveson@example.net",
  "andrew.yao@example.com",
  "manuela.veloso@example.org",
  "fred.brooks@example.net",
  "susan.eggers@example.com",
  "geoffrey.hinton@example.org",
  "cynthia.dwork@example.net",
];
