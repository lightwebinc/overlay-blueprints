# The finger token layout

The wire format of a profile-state token, and the one place it is defined.
`bfinger`, `overlayverify finger` and `tm_finger` all parse the same bytes, and
the vector in `fixtures/finger/` is those bytes.

It lives here because the **topic manager is the reader**. A manager decides
what its topic admits, so a layout defined anywhere else would be a client's
opinion about a decision the manager makes.

## Which of the two drafts was right: neither, and the reason matters

Two layouts were carried for months. One had a **delegate list** and no writer
key; the other had a **writer key** and no delegate list. Picking either as
drafted would have shipped an unverifiable token, because the delegation rule
needs both halves and each draft had one:

- Without the **writer key**, a verifier handed a token signed by a delegate
  cannot tell which key to check the signature against. It can try the identity
  key and every delegate in turn, but then "signed by someone authorised" and
  "signed by whoever happens to match" are the same test, and a token with an
  empty delegate list verifies differently depending on how many keys the
  verifier felt like trying.
- Without the **delegate list**, a verifier that knows which key signed cannot
  tell whether that key was allowed to. The update rule admits a delegate
  signer; nothing in the token says who the delegates are.

So the layout below is the union, and the two drafts are best read as each
having found half of it.

## The layout

BRC-48 PushDrop fields, in order. **K = 9**, and `len(Fields) == K+1` after
decode because `Lock` with `includeSignature` appends the signature as a field.

| # | Field | Bytes | Notes |
|---|---|---|---|
| 1 | magic | 8 | `bfinger` + one version byte, `0x01`. The version byte is what lets this table change later without a guess |
| 2 | identity key | 33 | compressed secp256k1. The subject |
| 3 | sequence | 8 | big-endian, strictly increasing |
| 4 | notBefore | 8 | big-endian unix seconds; 0 = no lower bound |
| 5 | notAfter | 8 | big-endian unix seconds; 0 = no expiry |
| 6 | kind | 1 | `1` create, `2` update, `3` delegate, `4` rotate, `5` retire |
| 7 | body | 0..4096 | JSON object, the published profile. Empty on retire |
| 8 | writer key | 33 | compressed. **The key that signed this token**: the identity, or a delegate |
| 9 | delegates | n × 34 | 33-byte key + 1-byte rights mask, repeated. Empty when none |
| 10 | signature | DER | over fields 1..9 concatenated, appended by `Lock` |

On a **rotate**, the successor is the `identity key` of the NEXT token and the
rotation is signed by the CURRENT pinned key; there is no separate successor
field. A draft carried one, and it duplicated state that the next token already
holds, which is how the two copies come to disagree.

### Why 8-byte sequence and 8-byte times

Both drafts used 4 bytes for at least one of these. Four bytes is ample for a
counter and a **footgun for a timestamp**: an owner who sets the sequence to
unix seconds is fine until 2106, and one who sets it to unix milliseconds
overflows in seven weeks. Nothing in the format stops either, and the cost of
removing the whole class of problem is four bytes on a token that is already
hundreds.

### Why JSON for the body

Self-describing, so a profile gains a field without changing this table. The
4 KB bound is the thing worth enforcing: a profile is published to a metered
plane and delivered to every subscriber, so an unbounded body is somebody
else's bandwidth.

### The rights mask

One byte per delegate, bit per field group the delegate may touch. Bit 0
`status`, bit 1 `plan`, bit 2 `link`. A delegate may never change the delegate
list itself, rotate the identity, or retire: those are bits nobody can hold,
which is what stops a delegate promoting itself.

## Verification order

A verifier checks in this order, and stops at the first failure:

1. the magic and version are this table's,
2. the DER signature over fields 1..9 is valid **for the writer key**,
3. the writer key is the identity key, or is in the delegate list with the
   rights the transition needs,
4. `sequence` is greater than the pinned one,
5. now is within `[notBefore, notAfter]`,
6. the transaction's merkle proof verifies against block headers.

Step 2 before step 3 is deliberate. Checking authorisation first invites a
verifier to decide who *should* have signed and then look for a signature to
match, which is how a token signed by nobody in particular gets accepted.

## The vector

`fixtures/finger/token-v1.hex` is one complete token, and the JSON beside it
names every field's offset and length. Any implementation that parses those
bytes into that table is compatible; anything else is not, whatever this
document says.
