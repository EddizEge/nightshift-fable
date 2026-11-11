"""
NIGHTSHIFT player car: the numbers every module agrees on.

Blender space while modelling: X = right, Y = FORWARD (the nose points to +Y), Z = up, metres.
Origin = centre of the wheelbase on the ground (z = 0 is the road).  The glTF exporter turns this
into the game's car space (Y up, the car faces -Z): gltf = (x, z, -y).

LEFT is -X (the driver sits on the left: x < 0).
"""

# ── axles and wheels ─────────────────────────────────────────────────────────────────────────
FRONT_AXLE_Y = 1.40
REAR_AXLE_Y = -1.40
WHEELBASE = FRONT_AXLE_Y - REAR_AXLE_Y
TRACK_F = 1.74          # distance between the centre planes of the two front tyres
TRACK_R = 1.76
WHEEL_R = 0.38          # tyre outer radius, same on both axles (the physics uses one radius)
RIM_R = 0.272           # outer lip of the rim (about 21.5 inch wheel)
TYRE_W_F = 0.265        # section width, front
TYRE_W_R = 0.325        # section width, rear
HUB_Z = WHEEL_R

WHEELS = {
    # key: (x of the tyre centre plane, y, tyre width, is_front)
    'FL': (-TRACK_F / 2, FRONT_AXLE_Y, TYRE_W_F, True),
    'FR': (+TRACK_F / 2, FRONT_AXLE_Y, TYRE_W_F, True),
    'RL': (-TRACK_R / 2, REAR_AXLE_Y, TYRE_W_R, False),
    'RR': (+TRACK_R / 2, REAR_AXLE_Y, TYRE_W_R, False),
}

# Wheel arch openings in the body side (circle in the YZ plane around the hub).
ARCH_R_F = 0.425
ARCH_R_R = 0.432

# ── body envelope ────────────────────────────────────────────────────────────────────────────
NOSE_Y = 2.36           # foremost point of the body
TAIL_Y = -2.26          # rearmost point
ROOF_Z = 1.175          # highest point of the roof
GROUND_CLEARANCE = 0.115
HALF_W_FRONT = 1.015    # body half width over the front wheels
HALF_W_DOOR = 0.955     # ... at the doors (waist)
HALF_W_REAR = 1.045     # ... over the rear wheels

# ── cabin (two seats, engine behind them) ────────────────────────────────────────────────────
COWL_Y = 0.95           # base of the windscreen on the centreline
COWL_Z = 0.865
HEADER_Y = 0.02         # top edge of the windscreen
HEADER_Z = 1.150
ROOF_PEAK_Y = -0.30
BULKHEAD_Y = -0.80      # wall behind the seats (engine bay behind it)
FLOOR_Z = 0.165         # top of the cabin floor
BELT_Z = 0.905          # lower edge of the side windows at the door (rises towards the rear)
CABIN_HALF_W_FLOOR = 0.74   # inner half width at the floor (inside the sills)
CABIN_HALF_W_BELT = 0.84    # inner half width at the window line
ROOF_HALF_W = 0.56          # half width of the roof panel

SEAT_X = 0.37               # centre of each seat (left seat at -SEAT_X)
SEAT_HIP = (-0.30, 0.335)   # (y, z) of the hip point
STEER_CENTRE = (-SEAT_X, 0.36, 0.705)   # centre of the steering wheel rim (driver on the left)
STEER_TILT_DEG = 20.0       # the wheel's axis points from the wheel towards the driver, this much above horizontal
STEER_RIM_R = 0.175
EYE_POINT = (-SEAT_X, -0.22, 1.005)

# Door mirrors: the foot of the stalk on the door, just behind the A pillar (right side; left is mirrored).
MIRROR_FOOT = (0.925, 0.70, 0.905)

# ── part and material names (the game binds to these) ────────────────────────────────────────
PART_NAMES = ['Body', 'MirrorL', 'MirrorR', 'Steering'] + [f'Wheel_{k}_{p}' for k in ('FL', 'FR', 'RL', 'RR') for p in ('Spin', 'Caliper')]

ANCHORS = ('headlightL', 'headlightR', 'taillightL', 'taillightR', 'exhaustL', 'exhaustR', 'hoodCam')
