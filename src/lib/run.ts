import haversineDistance from "haversine-distance";
import { RunItem, StoreItem } from "./types";

export const duration = (run: RunItem) => {
    if (!run.finishTimestamp || !run.startTimestamp) return 0
    return (run.finishTimestamp - run.startTimestamp) / 1000
}

export const distance_m = (points: StoreItem[]) => {
    let distance = 0
    if (points.length < 2) return distance
    for (let i = 0; i<points.length-1; i++) {
        const p1 = {lat: points[i].loc.lat, lon: points[i].loc.lon}
        const p2 = {lat: points[i+1].loc.lat, lon: points[i+1].loc.lon}
        console.log(p1)
        console.log(p2)

        distance += haversineDistance(p1, p2)
    }

    return distance
}

export const velocity_kph = (duration: number, distance: number) => {
    return (distance / 1000) / (duration / 3600)
}