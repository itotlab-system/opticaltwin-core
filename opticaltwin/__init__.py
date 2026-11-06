"""OpticalTwin's core library: building optical setups as OpenUSD scenes.

    optics_lib     make_* component generators, LIBRARY, breadboard/place/beam helpers
    templates      named setup recipes (slm_imaging, two_lens, blank)
    usd_utility    small USD helpers (component paths, references, render mode)
    beam_tracer    the planning beam through placed parts (geometry, no physics)
    beam_first     designing a bench outward from a laser
    generic_parts  stand-in parts for anything the catalogue lacks
    usd_to_web     setup .usda -> .glb for the static viewer
                   (python -m opticaltwin.usd_to_web)
    cad_importer   vendor STEP -> hi/lo component assets
                   (python -m opticaltwin.cad_importer; needs cadquery-ocp)

The web backend (backend/) and the scripts import from here; nothing here
imports from them.
"""
