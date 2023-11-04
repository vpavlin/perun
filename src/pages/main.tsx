import { Link, Outlet } from "react-router-dom";
import Wallet from "../components/wallet";
import {PiHamburgerBold} from "react-icons/pi"
import { useState } from "react";

const Main = () => {
    const [open, setOpen] = useState(false)
    const [drawer, setDrawer] = useState(false)
    return (<>
        <div className="drawer lg:drawer-open">
            <input id="my-drawer" type="checkbox" className="drawer-toggle"  checked={drawer} />
            <div className="drawer-content">
            <div className="flex flex-row items-center justify-between m-auto mb-2">
                <label htmlFor="my-drawer" className="drawer-button lg:hidden" onClick={() => setDrawer(!drawer)}><PiHamburgerBold size={40} /></label>
                <h1>PERun</h1>
            </div>
            <Outlet />
            </div> 
            <div className="drawer-side lg:mr-2">
                <label htmlFor="my-drawer" aria-label="close sidebar" className="drawer-overlay" onClick={() => setDrawer(!drawer)}></label>
                <ul className="menu p-4 w-80 min-h-full bg-base-200 text-base-content">
                    <li><Link onClick={() => setDrawer(!drawer)} to={"/run/"} >New</Link>  </li>
                    <li><Link onClick={() => setDrawer(!drawer)} to={"/runs/"}>Runs</Link></li>   
                    <li><Link onClick={() => setDrawer(!drawer)} to={"/settings/"} >Settings</Link></li> 
                    <li><Wallet /></li> 
                
                </ul>
            </div>
        </div>
    </>)
}

export default Main;