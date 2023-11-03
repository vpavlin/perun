import { Outlet } from "react-router-dom";
import Location from "../components/location";

const Main = () => {
    return (<>
        <div className="overflow-hidden max-h-fit">          
            <Outlet />
        </div>
    </>)
}

export default Main;