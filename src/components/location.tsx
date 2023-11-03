import { useReadLocalStorage } from "usehooks-ts";
import { useLocation } from "../hooks/useLocation";
import { MapContainer, Marker, Popup, TileLayer } from 'react-leaflet'
import { APP_PREFIX } from "../constants";


const Location = () => {
    const gpsRate = useReadLocalStorage<number>(`${APP_PREFIX}-gpsrate`)
    const loc = useLocation(gpsRate || 1000);

    return (
        <>
        { loc &&
            <div>
                <MapContainer className="w-full min-h-[400px] h-40" center={[loc.lat, loc.lon]} zoom={15} >
                    <TileLayer
                        attribution='&copy; <a href="http://osm.org/copyright">OpenStreetMap</a> contributors'
                        url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    />
                    <Marker position={[loc.lat, loc.lon]} />
                </MapContainer>
                <div>
                    Last Location Reading: {loc.timestamp}
                </div>
            </div>
        }
        </>
    )
}

export default Location;