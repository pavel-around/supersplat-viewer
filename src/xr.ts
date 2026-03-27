import {
    Color,
    Entity,
    Quat,
    Vec3,
    type CameraComponent
} from 'playcanvas';
import { XrControllers } from 'playcanvas/scripts/esm/xr-controllers.mjs';
import { XrNavigation } from 'playcanvas/scripts/esm/xr-navigation.mjs';

import { Global } from './types';

// On-screen debug overlay (visible on mobile without USB debugging)
const debugLines: string[] = [];
let debugEl: HTMLDivElement | null = null;

const dbg = (msg: string) => {
    console.log(msg);
    debugLines.push(`${new Date().toLocaleTimeString()} ${msg}`);
    if (debugLines.length > 20) debugLines.shift();
    if (!debugEl) {
        debugEl = document.createElement('div');
        debugEl.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:rgba(0,0,0,0.7);color:#0f0;font:12px monospace;padding:8px;max-height:40vh;overflow-y:auto;pointer-events:none;';
        // Try to append to ar-overlay if it exists, otherwise body
        const overlay = document.getElementById('ar-overlay');
        (overlay || document.body).appendChild(debugEl);
    }
    debugEl.textContent = debugLines.join('\n');
};

const initXr = (global: Global) => {
    const { app, events, state, camera } = global;

    state.hasAR = app.xr.isAvailable('immersive-ar');
    state.hasVR = app.xr.isAvailable('immersive-vr');
    dbg(`[XR init] hasAR=${state.hasAR}, hasVR=${state.hasVR}, xr.supported=${app.xr.supported}`);

    app.xr.on('available:immersive-ar', (available) => {
        dbg(`[XR] immersive-ar available changed: ${available}`);
        state.hasAR = available;
    });
    app.xr.on('available:immersive-vr', (available) => {
        state.hasVR = available;
    });

    const parent = camera.parent as Entity;
    const clearColor = new Color();

    const parentPosition = new Vec3();
    const parentRotation = new Quat();
    const cameraPosition = new Vec3();
    const cameraRotation = new Quat();
    const angles = new Vec3();

    parent.addComponent('script');
    const xrCtrl = parent.script.create(XrControllers);
    const xrNav = parent.script.create(XrNavigation);

    // ---- AR placement state ----
    let arPlaced = false;
    let gsplatEntity: Entity | null = null;

    // Build a simple reticle entity
    let reticle: Entity | null = null;
    const buildReticle = () => {
        const entity = new Entity('ar-reticle');
        entity.addComponent('render', { type: 'plane' });
        entity.setLocalScale(0.2, 1, 0.2);
        entity.enabled = false;
        app.root.addChild(entity);
        return entity;
    };

    const findGsplat = (): Entity | null => {
        // Try findByName first
        let entity = app.root.findByName('gsplat') as Entity | null;
        if (entity) return entity;

        // Fallback: find any entity with gsplat component
        const found = app.root.findComponent('gsplat');
        if (found) {
            dbg(`[AR] found gsplat via component on entity "${found.entity.name}"`);
            return found.entity;
        }

        return null;
    };

    app.xr.on('start', () => {
        app.autoRender = true;
        dbg(`[XR] session started, type=${app.xr.type}`);
        dbg(`[XR] hitTest.supported=${app.xr.hitTest.supported}`);

        // Cache camera state for restore on exit
        parentPosition.copy(parent.getPosition());
        parentRotation.copy(parent.getRotation());
        cameraPosition.copy(camera.getPosition());
        cameraRotation.copy(camera.getRotation());
        cameraRotation.getEulerAngles(angles);

        if (app.xr.type === 'immersive-ar') {
            // For AR: reset parent to origin so XR tracking starts clean
            parent.setPosition(0, 0, 0);
            parent.setEulerAngles(0, 0, 0);
            // Disable VR scripts in AR
            if (xrCtrl) xrCtrl.enabled = false;
            if (xrNav) xrNav.enabled = false;

            clearColor.copy(camera.camera.clearColor);
            camera.camera.clearColor = new Color(0, 0, 0, 0);

            // Show splat in front of camera
            gsplatEntity = findGsplat();
            dbg(`[AR] gsplat entity found: ${!!gsplatEntity}`);
            if (gsplatEntity) {
                // Place 1.5m in front of camera using camera's forward direction
                const camPos = camera.getPosition();
                const camFwd = camera.forward;
                const spawnDist = 1.5;
                const spawnPos = new Vec3(
                    camPos.x + camFwd.x * spawnDist,
                    camPos.y + camFwd.y * spawnDist,
                    camPos.z + camFwd.z * spawnDist
                );
                gsplatEntity.setPosition(spawnPos);
                gsplatEntity.setLocalEulerAngles(0, 0, 0);
                gsplatEntity.setLocalScale(0.15, 0.15, 0.15);
                gsplatEntity.enabled = true;
                arPlaced = false;
                dbg(`[AR] splat at cam+fwd*1.5: ${spawnPos.x.toFixed(2)},${spawnPos.y.toFixed(2)},${spawnPos.z.toFixed(2)}`);
                dbg(`[AR] cam pos: ${camPos.x.toFixed(2)},${camPos.y.toFixed(2)},${camPos.z.toFixed(2)}`);
            }

            arPlaced = false;

            // Create reticle
            if (!reticle) {
                reticle = buildReticle();
            }
            reticle.enabled = false;

            // Wait for hit test to become available
            if (app.xr.hitTest.available) {
                dbg('[AR] hitTest already available, starting...');
                startHitTests();
            } else {
                dbg('[AR] hitTest not yet available, waiting...');
                app.xr.hitTest.once('available', () => {
                    dbg('[AR] hitTest became available');
                    startHitTests();
                });
            }
        } else {
            // VR: offset camera parent
            parent.setPosition(cameraPosition.x, 0, cameraPosition.z);
            parent.setEulerAngles(0, angles.y, 0);
        }
    });

    const startHitTests = () => {
        dbg(`[AR] starting hit tests, sources count=${app.xr.hitTest.sources.length}`);

        // Viewer space hit test for reticle (center of screen)
        app.xr.hitTest.start({
            spaceType: 'viewer',
            callback: (err, hitTestSource) => {
                if (err) {
                    dbg(`[AR] viewer hit test ERROR: ${err.message}`);
                    return;
                }
                dbg('[AR] viewer hit test source created');

                let resultCount = 0;
                hitTestSource.on('result', (position: Vec3, rotation: Quat) => {
                    resultCount++;
                    if (resultCount <= 3) {
                        dbg(`[AR] reticle result #${resultCount}: ${position.x.toFixed(2)},${position.y.toFixed(2)},${position.z.toFixed(2)}`);
                    }
                    if (arPlaced) return;

                    if (reticle) {
                        reticle.enabled = true;
                        reticle.setPosition(position);
                        reticle.setRotation(rotation);
                    }
                });
            }
        });

        // Transient hit test for touch taps
        app.xr.hitTest.start({
            profile: 'generic-touchscreen',
            callback: (err, hitTestSource) => {
                if (err) {
                    dbg(`[AR] touch hit test ERROR: ${err.message}`);
                    return;
                }
                dbg('[AR] touch hit test source created');

                hitTestSource.on('result', (position: Vec3, rotation: Quat) => {
                    dbg(`[AR] TAP result: ${position.x.toFixed(2)},${position.y.toFixed(2)},${position.z.toFixed(2)}`);

                    if (!gsplatEntity) {
                        gsplatEntity = findGsplat();
                    }

                    if (gsplatEntity) {
                        const cp = camera.getPosition();
                        dbg(`[AR] cam: ${cp.x.toFixed(2)},${cp.y.toFixed(2)},${cp.z.toFixed(2)} | hit: ${position.x.toFixed(2)},${position.y.toFixed(2)},${position.z.toFixed(2)}`);
                        gsplatEntity.setPosition(position.x, position.y, position.z);
                        gsplatEntity.setLocalEulerAngles(0, 0, 0);
                        gsplatEntity.setLocalScale(0.15, 0.15, 0.15);
                        gsplatEntity.enabled = true;
                        dbg(`[AR] splat MOVED`);
                        arPlaced = true;
                        dbg('[AR] splat PLACED');
                    }

                    if (reticle) reticle.enabled = false;
                });
            }
        });
    };

    // Also listen for global hit test errors/events
    app.xr.hitTest.on('error', (err: Error) => {
        dbg(`[AR] hitTest global error: ${err.message}`);
    });
    app.xr.hitTest.on('add', () => {
        dbg(`[AR] hitTest source added, total=${app.xr.hitTest.sources.length}`);
    });
    app.xr.hitTest.on('remove', () => {
        dbg(`[AR] hitTest source removed, total=${app.xr.hitTest.sources.length}`);
    });

    app.xr.on('end', () => {
        app.autoRender = false;

        // Re-enable XR scripts
        if (xrCtrl) xrCtrl.enabled = true;
        if (xrNav) xrNav.enabled = true;

        // Clean up
        arPlaced = false;

        // Restore gsplat
        if (gsplatEntity) {
            gsplatEntity.enabled = true;
            gsplatEntity.setLocalScale(1, 1, 1);
            gsplatEntity.setPosition(0, 0, 0);
            gsplatEntity.setLocalEulerAngles(0, 0, 180);
        }

        if (reticle) reticle.enabled = false;

        // Restore camera
        parent.setPosition(parentPosition);
        parent.setRotation(parentRotation);
        camera.setPosition(cameraPosition);
        camera.setRotation(cameraRotation);

        if (app.xr.type === 'immersive-ar') {
            camera.camera.clearColor = clearColor;
        }

        requestAnimationFrame(() => {
            document.body.prepend(app.graphicsDevice.canvas);
            app.renderNextFrame = true;
        });
    });

    // Create a DOM overlay container for AR (shows HTML over camera)
    const overlayEl = document.createElement('div');
    overlayEl.id = 'ar-overlay';
    overlayEl.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999;pointer-events:none;';

    // Exit AR button inside overlay
    const exitBtn = document.createElement('button');
    exitBtn.textContent = 'EXIT AR';
    exitBtn.style.cssText = 'position:fixed;bottom:40px;left:50%;transform:translateX(-50%);padding:16px 32px;font-size:20px;font-weight:bold;background:#ff4444;color:#fff;border:none;border-radius:12px;pointer-events:auto;cursor:pointer;display:none;';
    exitBtn.addEventListener('click', () => {
        dbg('[AR] exit button clicked');
        app.xr.end();
    });
    overlayEl.appendChild(exitBtn);

    // Show/hide exit button on AR start/end
    app.xr.on('start', () => {
        if (app.xr.type === 'immersive-ar') exitBtn.style.display = 'block';
    });
    app.xr.on('end', () => {
        exitBtn.style.display = 'none';
    });
    document.body.appendChild(overlayEl);

    // Move debug overlay into AR overlay so it's visible during AR
    if (debugEl) {
        overlayEl.appendChild(debugEl);
        debugEl.style.pointerEvents = 'none';
    }

    const start = (type: string) => {
        camera.camera.nearClip = 0.01;
        camera.camera.farClip = 1000;
        if (type === 'immersive-ar') {
            app.xr.domOverlay.root = overlayEl;
            dbg('[AR] domOverlay set, starting AR session...');
        }
        app.xr.start(app.root.findComponent('camera') as CameraComponent, type, 'local-floor');
    };

    events.on('startAR', () => start('immersive-ar'));
    events.on('startVR', () => start('immersive-vr'));

    // Add a big visible AR button for mobile testing
    const testBtn = document.createElement('button');
    testBtn.textContent = 'START AR';
    testBtn.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:99999;padding:20px 40px;font-size:24px;font-weight:bold;background:#7B72FF;color:#fff;border:none;border-radius:12px;cursor:pointer;';
    testBtn.addEventListener('click', () => {
        dbg('[AR] button clicked, hasAR=' + state.hasAR);
        events.fire('startAR');
    });
    document.body.appendChild(testBtn);

    events.on('inputEvent', (event) => {
        if (event === 'cancel' && app.xr.active) {
            app.xr.end();
        }
    });
};

export { initXr };
