# Anyam example hybrid video player

This local fixture models a public player and private codec as two Source
Spaces in one checkout. The build transpiles one public entry point and rejects
the marker strings `privateCodec` and `private-codec`. The test checks those
markers in the emitted file.

## Run it

```bash
npm install
npm run check
```

The build writes `dist/public-player.js`. This demonstrates the selected
entry-point projection only. It does not establish separate Git histories,
adversarial import safety, or general private-content exclusion. Both source
directories remain present in the local checkout. Production disclosure needs
separate lineage and an enforced Project View. No source upload or public
repository publication occurs.
