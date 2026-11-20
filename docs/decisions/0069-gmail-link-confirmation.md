# 0068. Confirm a Gmail sender explicitly

A scanner that opens a verification link must leave it available for the owner. The console previews the link state through an owner-only endpoint, then posts the confirmation after a button press. A successful atomic update keeps the token digest and clears its expiry. A second click can therefore receive a used-link response. The existing positive-expiry check prevents replay. The next issued link replaces the digest. Digests cleared by older versions cannot identify a previously used link.
