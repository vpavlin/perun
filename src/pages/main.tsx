import { Link, Outlet } from "react-router-dom";
import Wallet from "../components/wallet";

const Main = () => {
    return (<>
        <div className="">
            <div className="flex lg:flex-row flex-col justify-center lg:space-x-2 w-full lg:space-y-0 my-2">
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