import { Link, Outlet } from "react-router-dom";

const Main = () => {
    return (<>
        <div className="overflow-hidden max-h-fit">
            <Link to={"/run/"} className="btn btn-lg btn-primary">New</Link>       
            <Outlet />
        </div>
    </>)
}

export default Main;