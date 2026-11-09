# Catalog adapters

Both supported clients must offer the catalog's explicit level choices,
including when discovery leaves `tunable` false. Preserve each level's id and
request settings. With no levels and `tunable` false, neither client offers
choices. The legacy client gates its choices on a boolean. The modern client
uses its explicit level list and accepts no capability boolean. The adapters
may use different representations. Run `python3 tests/test_catalog.py`.
