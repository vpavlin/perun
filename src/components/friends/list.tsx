import { useReadLocalStorage } from "usehooks-ts";
import { APP_PREFIX } from "../../constants";
import { FriendInfo } from "./profile";
import { Hashicon } from '@emeraldpay/hashicon-react';


const List = () => {
    const friends = useReadLocalStorage<FriendInfo[]>(`${APP_PREFIX}-friends`)
    return (
        <>
        <div className="text-center w-fit m-auto">
        {
            friends && friends.map((f) => <div className="flex flex-row items-center space-x-5">
                <Hashicon value={f.data.address} /><span>{f.data.address}</span></div>)
        }
        </div>
        </>
    ) 
}

export default List;