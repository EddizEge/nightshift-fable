import { Quaternion, Vector3 } from 'three';
import type { PlayerState, VehicleDims } from '../core/types';

export const DEFAULT_DIMS: VehicleDims = {
  length: 4.33,
  width: 2.0,
  height: 1.2,
  wheelBase: 2.72,
  trackFront: 1.7,
  trackRear: 1.7,
  wheelRadius: 0.38,
  frontAxle: 1.36,
  rearAxle: 1.36,
  cgHeight: 0.45,
  mass: 1500,
};

export function createPlayerState(dims: VehicleDims = DEFAULT_DIMS): PlayerState {
  return {
    position: new Vector3(),
    quaternion: new Quaternion(),
    velocity: new Vector3(),
    heading: 0,
    yawRate: 0,
    speed: 0,
    speedKmh: 0,
    lateralSpeed: 0,
    s: 0,
    d: 0,
    relHeading: 0,
    throttle: 0,
    brake: 0,
    steerAngle: 0,
    handbrake: false,
    rpm: 900,
    rpm01: 0.1,
    gear: 1,
    nitro01: 1,
    nitroActive: false,
    accelLong: 0,
    accelLat: 0,
    wheelSkid: [0, 0, 0, 0],
    wheelSpin: [0, 0, 0, 0],
    suspension: [0, 0, 0, 0],
    bodyPitch: 0,
    bodyRoll: 0,
    wheelContacts: [new Vector3(), new Vector3(), new Vector3(), new Vector3()],
    damage: 0,
    alive: true,
    wrecked: false,
    dims,
  };
}
