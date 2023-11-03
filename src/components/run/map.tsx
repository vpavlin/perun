import { MapContainer, TileLayer, Marker } from "react-leaflet";
import { useReadLocalStorage } from "usehooks-ts";
import { APP_PREFIX } from "../../constants";
import { useLocation } from "../../hooks/useLocation";

const Map = () => {
    const gpsRate = useReadLocalStorage<number>(`${APP_PREFIX}-gpsrate`)
    const loc = useLocation(gpsRate || 1000);

    return (<>
        {loc &&
            <MapContainer className="min-w-full w-full w-fill min-h-[1000px] h-full z-0" style={{width: "100%", height: "100%"}} center={[loc.lat, loc.lon]} zoom={15} >
                <TileLayer
                    attribution='&copy; <a href="http://osm.org/copyright">OpenStreetMap</a> contributors'
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                />
                <Marker position={[loc.lat, loc.lon]} />
            </MapContainer>
        }
    </>)
}

export default Map;