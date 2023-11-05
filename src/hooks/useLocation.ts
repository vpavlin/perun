import { useEffect, useMemo, useState } from "react"
import Geohash from "latlon-geohash"


export type GeoLocation = {
    lat: number,
    lon: number,
    speed: number | null,
    heading: number | null,
    geoHash: string
    timestamp: number
}


export const useLocation = (rate: number = 1000) => {
    const [location, setLocation ] = useState<GeoLocation>()

    const trackOptions = {
        enableHighAccuracy: true,
        maximumAge: rate,
        timeout: 3000,
      };

    const update = () => {
        if (navigator.geolocation) {
            navigator.geolocation.getCurrentPosition((loc: GeolocationPosition) => {
                console.log(loc)

                setLocation({
                    heading: loc.coords.heading,
                    lat: loc.coords.latitude,
                    lon: loc.coords.longitude,
                    speed: loc.coords.speed,
                    geoHash: Geohash.encode(loc.coords.latitude, loc.coords.longitude),
                    timestamp: loc.timestamp
                })
                console.log(Geohash.encode(loc.coords.latitude, loc.coords.longitude))
            }, () => {}, trackOptions)
        }
    }

    useEffect(() => {
        const interval = setInterval(() => update(), rate)
        return () => {
            clearInterval(interval)
        }
    }, [])

    return useMemo(() => (location), [location])
}