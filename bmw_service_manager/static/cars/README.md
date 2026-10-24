# Car models

Drive Replay draws the car from a log as one of these models: the one for its chassis code, else
the nearest there is (`near`), else one of the same series (`models.json`, read by
`replay/car3d.js`). All are by [Ddiaz Design](https://sketchfab.com/ddiaz-design) on Sketchfab, used under their licences,
and adapted by `tools/car_model.py`: turned to the car's axes at real size, the wheels split out,
the body merged by material, the geometry and textures compressed. The adapted models are shared
under the same licences as the originals.

| File | Model | Chassis | Nearest for | Licence |
|---|---|---|---|---|
| `x1-f48.glb` | [2020 BMW X1 xDrive 18d](https://sketchfab.com/3d-models/4ca3a2247af44e51919074565ed93486) | F48 | F49, F45, F46, U11 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `x2-f39.glb` | [2019 BMW X2 xDrive20d M Sport X](https://sketchfab.com/3d-models/cea85cf2fa9d4af682c2446cced5ccae) | F39 | U10 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `x3-g01.glb` | [2022 BMW X3 xDrive 30i](https://sketchfab.com/3d-models/b5c660d8e39340538a06561eaca69b5f) | G01 | F25, F97, G08, G45 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `x4-g02.glb` | [2019 BMW X4 xDrive20d](https://sketchfab.com/3d-models/a5eb74a0ad3f4ed594e854a862a0e029) | G02 | F26, F98 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `x5-f15.glb` | [2015 BMW X5](https://sketchfab.com/3d-models/a2e7d663902e4be7bd170fdb9f333ad8) | F15 | F85, E70 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `x5-g05.glb` | [2019 BMW X5 xDrive30d](https://sketchfab.com/3d-models/850fb32f984c4630969840fc61f44902) | G05 | F95, G18 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `x6-f16.glb` | [2015 BMW X6 F16](https://sketchfab.com/3d-models/3e1551da01db4bfbb1ff6aa765cb4ff3) | F16 | F86, E71 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `x6-g06.glb` | [2020 BMW X6 xDrive40i](https://sketchfab.com/3d-models/43b22440191d48b888f8f267d105b422) | G06 | F96 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `x7-g07.glb` | [2019 BMW X7 xDrive40i](https://sketchfab.com/3d-models/a4b1edf1ec614f06b5d4db7208fe9650) | G07 | G09 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `1-f20.glb` | [2018 BMW M140i](https://sketchfab.com/3d-models/24f09cc46773424fb2a3922427f1c37d) | F20, F21 | F40, E87, E81 | [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/) |
| `2-f22.glb` | [2014 BMW M235i Coupe](https://sketchfab.com/3d-models/a347df8f1ba8404fabe46d87f8f8430b) | F22 | F23, G42 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `2gc-f44.glb` | [2021 BMW 218i Gran Coupé](https://sketchfab.com/3d-models/c2e7d8cea31546b5a9f46d5d26c9471d) | F44 | U06, U07 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `m2-f87.glb` | [2019 BMW M2 Competition](https://sketchfab.com/3d-models/e43741a793da4e3f8e9747e31a1a8ff6) | F87 | — | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `m2-g87.glb` | [2023 BMW M2 G87 Coupé](https://sketchfab.com/3d-models/7a608716b25b4589a8cc323e9cbd1e8d) | G87 | — | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `3-g20.glb` | [2020 BMW M340i xDrive](https://sketchfab.com/3d-models/69dbf0293c6f4959a90d5bd0d68e097f) | G20 | G28, G80 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `m3t-g81.glb` | [2023 BMW M3 Touring](https://sketchfab.com/3d-models/f540fdbc0d93435d96ef354f01720dc0) | G81 | G21 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `m3-f80.glb` | [2015 BMW M3 (F80)](https://sketchfab.com/3d-models/547ab5f3b534473fbef71404bae708c5) | F80 | F30, F31, F35 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `3gt-f34.glb` | [2013 BMW 335i Gran Turismo (F34)](https://sketchfab.com/3d-models/e4f91073e4374de5a3ff0858f25400d2) | F34 | — | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `4-g22.glb` | [2021 BMW 430i xDrive Coupé](https://sketchfab.com/3d-models/3d507e8432494480b31bdc0dcdcf51d5) | G22 | G23 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `m4-f82.glb` | [2018 BMW M4 Coupe (F82 LCi)](https://sketchfab.com/3d-models/6dcbd7234690431e87e68f580be60e22) | F82 | F32, F36 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `m4c-f83.glb` | [2018 BMW M4 Convertible (F83)](https://sketchfab.com/3d-models/2f758a606f004d7e8932e2845c7e9056) | F83 | F33 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `4gc-g26.glb` | [2022 BMW M440i xDrive Gran Coupé](https://sketchfab.com/3d-models/a41efb9c01e64d9d81a7896d2bbbb167) | G26 | — | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `m4-g82.glb` | [2025 BMW M4 Competition](https://sketchfab.com/3d-models/f8141ecd755547989c9209784b71ad43) | G82 | G83 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `m5-f90.glb` | [2021 BMW M5 Competition](https://sketchfab.com/3d-models/29a4c13761cb40e6a050871bd40a0963) | F90 | G30, G31, G38, F10, F11, F18 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `m5-g90.glb` | [2025 BMW M5 Sedan](https://sketchfab.com/3d-models/4ab34c43bada482b8e467be97ebaeba3) | G90 | G60, G61, G99 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `5gt-f07.glb` | [2014 BMW 5-Series Gran Turismo](https://sketchfab.com/3d-models/124325f980584b10b147c4aec85f9b0a) | F07 | G32 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `m6-f13.glb` | [2013 BMW M6 Coupe F13](https://sketchfab.com/3d-models/dd710d1396a04a9c9d3831285b2f2874) | F13 | F12, F06 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `7-g12.glb` | [2020 BMW 750Li xDrive](https://sketchfab.com/3d-models/0c3ebd90567a409894682becd3d92efe) | G11, G12 | F01, F02, F04, G70 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `8gc-g16.glb` | [2020 BMW M850i Gran Coupe](https://sketchfab.com/3d-models/6d51b027dba044a4aa6c93d11228f03f) | G16 | — | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `m8-f92.glb` | [2020 BMW M8 Coupé](https://sketchfab.com/3d-models/f3557814de544abe8be017405f2eec49) | F92 | G15 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `m8c-f91.glb` | [2020 BMW M8 Competition Convertible](https://sketchfab.com/3d-models/f7c1401ee5724e969db890c207fb099f) | F91 | G14 | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |
| `z4-g29.glb` | [2019 BMW Z4 M40i](https://sketchfab.com/3d-models/c6178ca22425467080939e29e1b42f8c) | G29 | — | [CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/) |

BMW, the model names and the BMW logo are trademarks of BMW AG. These models are not made or
endorsed by BMW.
