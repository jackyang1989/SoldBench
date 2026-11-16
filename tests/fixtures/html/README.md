# SoldBench synthetic HTML corpus

These files are authored fixtures, not eBay captures or reverse-engineered selectors.
`SOURCE_ID` / `QUERY_HASH` are replaced with the current synthetic job binding.
The profile is an offline parser contract and grants no source access, storage,
commercial use, image distribution, or network permission.

`search.html` covers a sold row, lazy main image with width-based srcset,
non-primary gallery, advertisement and recommendation exclusion, private seller
withholding, and scripts/iframes which must never run or load resources.
Negative cases are derived from this immutable authored sample in the test suite.
