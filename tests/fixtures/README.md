# Test fixtures

`gopro-hero6-gps.mp4`: the first 6 s of `samples/hero6.mp4` from GoPro's
[gpmf-parser](https://github.com/gopro/gpmf-parser) (Apache 2.0 or MIT), scaled down to 320 × 182
and re-encoded small, with its GoPro telemetry track (GPMF: GPS5 with GPSU, ACCL, GYRO) copied as it
was. Made with:

```
ffmpeg -i hero6.mp4 -t 6 -map 0:0 -map 0:1 -map 0:3 -vf scale=320:-2 -c:v libx264 -preset slow -crf 34 \
  -c:a aac -b:a 32k -ac 1 -c:d copy -copy_unknown -tag:d gpmd -map_metadata 0 gopro-hero6-gps.mp4
```

`LOG_00042_20261111-0805.BLR`: a made-up BLE CAN Logger session, as the logger writes one to its USB
drive (session header, GPS fixes, OBD values, events), with a torn record and a gap in it on
purpose. It's from the Boostbook iOS app's tests, which write and check it; its VIN is a sample.
