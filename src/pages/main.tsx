import { Link, Outlet } from "react-router-dom";
import Wallet from "../components/wallet";

const Main = () => {
    return (<>
        <div className="overflow-hidden max-h-fit">
            <div className="flex flex-row justify-center space-x-2">
                <Link to={"/run/"} className="btn btn-lg btn-primary">New</Link>  
                <Link to={"/runs/"} className="btn btn-lg btn-primary">Runs</Link>     
                <Link to={"/settings/"} className="btn btn-lg btn-primary">Settings</Link>     

                <Wallet />  
            </div>
            <Outlet />
        </div>
    </>)
}

export default Main;